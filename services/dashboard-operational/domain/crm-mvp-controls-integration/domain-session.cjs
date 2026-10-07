'use strict';

const {AsyncLocalStorage} = require('node:async_hooks');
const states = new WeakMap();
const internalErrors = new WeakSet();
const VERSION = 'crm-domain-session-root-v1';
const sqlstate = code => typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null;
const failure = (code, cause) => {
  const error = Object.assign(new Error(code), {code, sqlstate: sqlstate(cause?.code)});
  internalErrors.add(error);
  return error;
};
const fatal = error => ['40001', '57014', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ENOTCONN'].includes(error?.code) || sqlstate(error?.code)?.startsWith('08');

// Root injects an existing pg client. This module never connects, authenticates,
// creates a database, issues grants, or treats source readiness as admission.
function create({enabled = false, client} = {}) {
  const ready = enabled === true && client && typeof client === 'object' && typeof client.query === 'function';
  let state;
  if (ready) {
    state = states.get(client);
    if (!state) {
      state = {busy: false, poisoned: false, transaction: 'none', pending: 0, context: new AsyncLocalStorage()};
      states.set(client, state);
    }
  }
  const requireReady = () => {
    if (!ready) throw failure('CRM_DOMAIN_SESSION_OFF');
  };
  const poison = () => {
    requireReady();
    state.poisoned = true;
  };

  async function query(text, params) {
    requireReady();
    const lease = state.context.getStore();
    if (!lease?.active) throw failure('CRM_DOMAIN_SESSION_LEASE_REQUIRED');
    if (typeof text !== 'string' || !text.trim() || params !== undefined && !Array.isArray(params)) throw failure('CRM_DOMAIN_SESSION_QUERY_REFUSED');
    // Domain SQL is a single static statement with values in parameters. Refuse
    // comments and delimiters before execution instead of guessing SQL tokens.
    if (/\/\*|--|;/.test(text)) throw failure('CRM_DOMAIN_SESSION_QUERY_REFUSED');
    if (state.pending) throw failure('CRM_DOMAIN_SESSION_QUERY_BUSY');
    const command = text.trim().toUpperCase();
    const begin = /^BEGIN(?: ISOLATION LEVEL (?:SERIALIZABLE|REPEATABLE READ)(?: READ ONLY)?)?$/.test(command);
    const finish = command === 'COMMIT' || command === 'ROLLBACK';
    const cleanup = command === 'ROLLBACK' && ['active', 'unknown'].includes(state.transaction);
    if (state.poisoned && !cleanup) throw failure('CRM_DOMAIN_SESSION_POISONED');
    if (/^(BEGIN|START|COMMIT|ROLLBACK|END|ABORT|SAVEPOINT|RELEASE|PREPARE TRANSACTION|SET TRANSACTION)\b/.test(command) && !begin && !finish) throw failure('CRM_DOMAIN_SESSION_TRANSACTION_REFUSED');
    if (begin && state.transaction !== 'none' || finish && !['active', 'unknown'].includes(state.transaction) || command === 'COMMIT' && state.transaction === 'unknown') throw failure('CRM_DOMAIN_SESSION_TRANSACTION_REFUSED');

    state.pending++;
    if (begin) state.transaction = 'starting';
    if (finish) state.transaction = 'finishing';
    try {
      const result = await client.query(text, params);
      if (begin || finish) {
        const expected = begin ? 'BEGIN' : command;
        if (result?.command !== expected) {
          state.poisoned = true;
          state.transaction = 'unknown';
          throw failure('CRM_DOMAIN_SESSION_ACK_UNKNOWN');
        }
        state.transaction = begin ? 'active' : 'none';
      } else if (!result || Array.isArray(result) || ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(result.command)) {
        state.poisoned = true;
        state.transaction = 'unknown';
        throw failure('CRM_DOMAIN_SESSION_PROTOCOL_REFUSED');
      }
      return result;
    } catch (error) {
      if (begin || finish) {
        state.poisoned = true;
        state.transaction = 'unknown';
        throw failure('CRM_DOMAIN_SESSION_ACK_UNKNOWN', error);
      }
      if (fatal(error)) state.poisoned = true;
      // SQLSTATE only: never expose the SQL, parameters, credentials or server message.
      if (internalErrors.has(error)) throw error;
      throw failure('CRM_DOMAIN_SESSION_QUERY_FAILED', error);
    } finally {
      state.pending--;
    }
  }

  async function withDomainSession(work) {
    requireReady();
    if (typeof work !== 'function') throw failure('CRM_DOMAIN_SESSION_CALLBACK_REFUSED');
    if (state.poisoned) throw failure('CRM_DOMAIN_SESSION_POISONED');
    if (state.busy) throw failure('CRM_DOMAIN_SESSION_BUSY');
    state.busy = true;
    const lease = {active: true};
    let value, thrown, threw = false;
    try {
      value = await state.context.run(lease, () => work());
    } catch (error) {
      threw = true;
      thrown = error;
    } finally {
      lease.active = false;
      // An unfinished operation can never hand this client to another module.
      // No automatic retry, COMMIT, ROLLBACK, replacement client or rearm.
      if (state.pending || state.transaction !== 'none') state.poisoned = true;
      state.busy = false;
    }
    if (state.pending) throw failure('CRM_DOMAIN_SESSION_PENDING_QUERY');
    if (state.transaction !== 'none') throw failure('CRM_DOMAIN_SESSION_UNCLOSED_TRANSACTION');
    if (state.poisoned) throw failure('CRM_DOMAIN_SESSION_POISONED', thrown);
    if (threw) throw thrown;
    return value;
  }

  return Object.freeze({
    version: VERSION, sourceOnly: true, operational: false, authorizesSend: false,
    authorityProved: false,
    client: Object.freeze({query}), withDomainSession, poison,
    status: () => Object.freeze({enabled: !!ready, busy: state?.busy ?? false, poisoned: state?.poisoned ?? false,
      transaction: state?.transaction ?? 'none', pending: state?.pending ?? 0,
      authorityProved: false, operational: false, authorizesSend: false})
  });
}

module.exports = Object.freeze({VERSION, ENABLED: false, create});
