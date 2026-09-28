#!/usr/bin/env python3
"""Isolated CI design probe, NOT a production migration or a LOGIN transition.

Needs an empty crm_pgp_prototype database on PostgreSQL 17.10 in a disposable
loopback container, synthetic admin password, Node, GnuPG, psql and Docker logs.
No credential, key, ciphertext, SQL error text or raw log is printed.
"""
import argparse
import base64
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import uuid

ROLE = 'crm_pgp_probe_worker'
DB = 'crm_pgp_prototype'


def require(ok, code):
    if not ok:
        raise ValueError('PGP_PROTOTYPE_' + code)


def process(args, *, data=None, env=None, timeout=45):
    r = subprocess.run(args, input=data, capture_output=True, timeout=timeout, env=env)
    require(len(r.stdout) + len(r.stderr) < 8 * 1024 * 1024, 'OUTPUT_LIMIT')
    return r


def prepare_sql(pub, nonce, mode='normal'):
    require(mode in ('normal', 'rollback', 'cancel', 'alter_error'), 'MODE')
    require(str(uuid.UUID(nonce)) == nonce, 'NONCE')
    require(isinstance(pub, bytes) and 128 < len(pub) < 16384, 'PUBLIC_KEY')
    key = base64.b64encode(pub).decode()
    key_hash = hashlib.sha256(pub).hexdigest()
    target = ROLE if mode != 'alter_error' else 'crm_pgp_probe_absent'
    after = "RAISE EXCEPTION 'synthetic rollback';" if mode == 'rollback' else "PERFORM pg_sleep(2);" if mode == 'cancel' else ''
    return f"""DO $pgp_probe$
DECLARE secret text; encrypted bytea; target_oid oid;
BEGIN
 IF current_database()<>'{DB}' OR current_user<>'postgres' OR
    current_setting('server_version_num')::int<>170010 THEN RAISE EXCEPTION 'PGP_PROTOTYPE_SCOPE'; END IF;
 IF current_setting('statement_timeout')::interval<=interval '0' OR
    current_setting('statement_timeout')::interval>interval '30 seconds' THEN RAISE EXCEPTION 'PGP_PROTOTYPE_TIMEOUT'; END IF;
 IF EXISTS(SELECT 1 FROM pg_settings WHERE name IN ('shared_preload_libraries','session_preload_libraries','local_preload_libraries') AND setting<>'') OR current_setting('pgaudit.log',true) IS NOT NULL OR current_setting('auto_explain.log_min_duration',true) IS NOT NULL THEN RAISE EXCEPTION 'PGP_PROTOTYPE_HOOKS'; END IF;
 PERFORM pg_advisory_xact_lock(78511299);
 IF EXISTS(SELECT 1 FROM crm_pgp_probe.receipt) THEN RAISE EXCEPTION 'PGP_PROTOTYPE_ALREADY_PREPARED'; END IF;
 SELECT oid INTO STRICT target_oid FROM pg_authid WHERE rolname='{ROLE}' AND NOT rolcanlogin AND rolpassword IS NULL;
 PERFORM set_config('password_encryption','scram-sha-256',true);
 -- Only public material occurs in the submitted DO. OpenPGP is pgcrypto's
 -- standard RFC4880 implementation; there is no custom encryption scheme.
 BEGIN
 secret:=encode(public.gen_random_bytes(32),'hex');
 encrypted:=public.pgp_pub_encrypt(jsonb_build_object('nonce','{nonce}',
   'role','{ROLE}','database','{DB}','password',secret)::text,
   decode('{key}','base64'),'cipher-algo=aes256,compress-algo=0,disable-mdc=0');
  EXECUTE format('ALTER ROLE %I NOLOGIN PASSWORD %L','{target}',secret);
  {after}
  INSERT INTO crm_pgp_probe.receipt(nonce,role_oid,key_sha256,ciphertext,auth_proof_hash)
  SELECT '{nonce}'::uuid,target_oid,'{key_hash}',encrypted,
    encode(sha256(convert_to(jsonb_build_object('role_oid',oid,'role',rolname,'verifier',rolpassword)::text,'UTF8')),'hex') FROM pg_authid WHERE oid=target_oid AND NOT rolcanlogin;
 EXCEPTION
  WHEN query_canceled OR assert_failure THEN secret:=NULL; RAISE EXCEPTION 'PGP_PROTOTYPE_CANCELLED';
  WHEN OTHERS THEN secret:=NULL; RAISE EXCEPTION 'PGP_PROTOTYPE_FAILED';
 END;
 secret:=NULL;
END $pgp_probe$;"""


def check_logs(server_logs, client_outputs, known_secrets, server_markers):
    # Prove the server stream independently: client errors repeat these codes
    # and must never make an empty/truncated Docker log look complete.
    require(server_markers and all(marker and marker in server_logs for marker in server_markers)
            and b'statement: DO $pgp_probe$' in server_logs
            and all(re.search(rb'ERROR:[^\r\n]*\b' + code + rb'\b', server_logs)
                    for code in (b'PGP_PROTOTYPE_ALREADY_PREPARED', b'PGP_PROTOTYPE_FAILED',
                                 b'PGP_PROTOTYPE_CANCELLED', b'PGP_PROTOTYPE_HOOKS')), 'LOG_COVERAGE')
    evidence = server_logs + b'\n' + client_outputs
    require(all(secret and secret not in evidence for secret in known_secrets), 'LOG_SECRET')
    require(not re.search(rb"ALTER ROLE\s+crm_pgp_probe_\w+\s+NOLOGIN\s+PASSWORD\s+'[a-f0-9]{64}'", evidence), 'LOG_DYNAMIC_SECRET')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--port', type=int, required=True)
    p.add_argument('--container-id', required=True)
    args = p.parse_args()
    require(os.environ.get('CI') == 'true' and os.environ.get('CRM_PGP_PROTOTYPE') == '1', 'CI_ONLY')
    require(1024 <= args.port <= 65535 and re.fullmatch(r'[a-f0-9]{12,64}', args.container_id), 'TARGET')
    env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
    env.update(PGHOST='127.0.0.1', PGPORT=str(args.port), PGDATABASE=DB, PGUSER='postgres',
               PGPASSWORD='synthetic-admin-password', PGCONNECT_TIMEOUT='3')
    client_outputs = []
    def sql(query, *, error=False, timeout=20000):
        local_env = {**env, 'PGOPTIONS': f'-c statement_timeout={timeout} -c application_name=crm-pgp-prototype -c log_statement=all -c log_min_error_statement=error -c log_error_verbosity=verbose'}
        r = process(['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '--no-password'], data=query.encode(), env=local_env)
        client_outputs.append(r.stderr)
        require((r.returncode != 0) if error else (r.returncode == 0), 'SQL_RESULT')
        return r.stdout.strip()
    identity = json.loads(sql("SELECT json_build_object('version',current_setting('server_version_num')::int,'database',current_database(),'role',current_user,'fixture_absent',to_regnamespace('crm_pgp_probe') IS NULL AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('crm_pgp_probe_worker','crm_pgp_probe_absent')));"))
    require(identity == {'version': 170010, 'database': DB, 'role': 'postgres', 'fixture_absent': True}, 'IDENTITY')
    require(sql("SELECT NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public');") == b't', 'EMPTY_DATABASE')
    sql("CREATE EXTENSION pgcrypto; CREATE SCHEMA crm_pgp_probe; REVOKE ALL ON SCHEMA crm_pgp_probe FROM PUBLIC; CREATE TABLE crm_pgp_probe.receipt(nonce uuid PRIMARY KEY, role_oid oid UNIQUE NOT NULL,key_sha256 text NOT NULL,ciphertext bytea NOT NULL,auth_proof_hash text NOT NULL); REVOKE ALL ON crm_pgp_probe.receipt FROM PUBLIC; CREATE ROLE crm_pgp_probe_worker NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;")
    checks = []
    known_secrets = []
    try:
        with tempfile.TemporaryDirectory(prefix='crm-pgp-synthetic-') as temp, ExitStack() as cleanup:
            os.chmod(temp, 0o700)
            gpg = ['gpg', '--homedir', temp, '--batch', '--no-tty']
            operator_dir = str(Path(temp) / 'operator')
            operator = ['node', str(Path(__file__).with_name('operator.cjs').resolve())]
            operator_env = {**os.environ, 'CRM_PGP_PROTOTYPE_CAPTURE': '1'}
            generated = process(operator + ['generate', '--directory', operator_dir], env=operator_env)
            require(generated.returncode == 0, 'OPERATOR_GENERATE')
            public = json.loads(generated.stdout)
            require(set(public) == {'version', 'library', 'nonce', 'role', 'database', 'key_sha256', 'key_fingerprint', 'public_key_b64'}
                    and public['version'] == 1 and public['library'] == 'openpgp@6.3.1'
                    and public['role'] == ROLE and public['database'] == DB, 'OPERATOR_PUBLIC')
            public_key = base64.b64decode(public['public_key_b64'], validate=True)
            require(public['key_sha256'] == hashlib.sha256(public_key).hexdigest(), 'OPERATOR_KEY_HASH')
            nonce = public['nonce']
            reopened = process(operator + ['public', '--directory', operator_dir], env=operator_env)
            require(reopened.returncode == 0 and json.loads(reopened.stdout) == public, 'OPERATOR_DURABLE_KEY')
            # GnuPG is only an independent CI reference. It imports the same
            # persisted Node key; no second keypair can mask interoperability.
            cleanup.callback(lambda: require(process(['gpgconf', '--homedir', temp, '--kill', 'gpg-agent'], timeout=10).returncode == 0, 'GPG_REFERENCE_CLEANUP'))
            require(process(gpg + ['--import', str(Path(operator_dir) / 'private-key.bin')]).returncode == 0, 'GPG_REFERENCE_IMPORT')
            server_markers = [nonce.encode()]
            statement = prepare_sql(public_key, nonce)
            sql(statement)
            # Simulate a lost write acknowledgement: only a new read obtains the
            # same durable receipt. Do not generate a new key/nonce or retry write.
            read = "SELECT json_build_object('ciphertext',encode(ciphertext,'base64'),'key_sha256',key_sha256,'auth_proof_hash',auth_proof_hash,'no_login',NOT a.rolcanlogin,'scram',a.rolpassword LIKE 'SCRAM-SHA-256$%','matches',auth_proof_hash=encode(sha256(convert_to(jsonb_build_object('role_oid',a.oid,'role',a.rolname,'verifier',a.rolpassword)::text,'UTF8')),'hex')) FROM crm_pgp_probe.receipt r JOIN pg_authid a ON a.oid=r.role_oid;"
            receipt_raw = sql(read)
            receipt = json.loads(receipt_raw)
            require(receipt['no_login'] and receipt['scram'] and receipt['matches'] and receipt['key_sha256'] == public['key_sha256'], 'PREPARED_RECEIPT')
            operator_read = process(operator + ['decrypt', '--directory', operator_dir],
                                    data=json.dumps({'ciphertext': receipt['ciphertext'], 'key_sha256': receipt['key_sha256'], 'nonce': nonce}).encode(),
                                    env=operator_env)
            require(operator_read.returncode == 0, 'OPERATOR_DECRYPT')
            payload = json.loads(operator_read.stdout)
            decrypted = process(gpg + ['--decrypt'], data=base64.b64decode(receipt['ciphertext']))
            require(decrypted.returncode == 0, 'DECRYPT')
            require(json.loads(decrypted.stdout) == payload, 'INDEPENDENT_DECRYPT_MATCH')
            require(set(payload) == {'nonce', 'role', 'database', 'password'} and payload['nonce'] == nonce and payload['role'] == ROLE and payload['database'] == DB and re.fullmatch(r'[a-f0-9]{64}', payload['password']), 'PLAINTEXT_IDENTITY')
            known_secrets += [payload['password'].encode(), sql("SELECT rolpassword FROM pg_authid WHERE rolname='crm_pgp_probe_worker';")]
            sql(statement, error=True)
            require(sql(read) == receipt_raw, 'REPLAY_MUTATED_RECEIPT')
            checks += ['node_durable_key_before_sql', 'pgcrypto_to_openpgpjs_roundtrip', 'gnupg_independent_same_ciphertext', 'no_login', 'scram_server_generated', 'lost_ack_readback', 'replay_refused', 'auth_proof_hash_matches_catalog']
            for mode in ('rollback', 'cancel', 'alter_error'):
                sql("TRUNCATE crm_pgp_probe.receipt; ALTER ROLE crm_pgp_probe_worker PASSWORD NULL;")
                mode_nonce = str(uuid.uuid4())
                server_markers.append(mode_nonce.encode())
                sql(prepare_sql(public_key, mode_nonce, mode), error=True, timeout=500 if mode == 'cancel' else 20000)
                require(sql("SELECT NOT rolcanlogin AND rolpassword IS NULL AND NOT EXISTS(SELECT 1 FROM crm_pgp_probe.receipt) FROM pg_authid WHERE rolname='crm_pgp_probe_worker';") == b't', 'ROLLBACK_STATE')
                checks.append(mode + '_atomic')
            for setting in ('pgaudit.log', 'auto_explain.log_min_duration'):
                hook_nonce = str(uuid.uuid4())
                server_markers.append(hook_nonce.encode())
                sql("SET " + setting + ("='role';" if setting == 'pgaudit.log' else "='0';") + prepare_sql(public_key, hook_nonce), error=True)
                require(sql("SELECT rolpassword IS NULL AND NOT EXISTS(SELECT 1 FROM crm_pgp_probe.receipt) FROM pg_authid WHERE rolname='crm_pgp_probe_worker';") == b't', 'HOOK_REFUSAL_STATE')
            checks.append('dynamic_audit_settings_refused_before_secret')
            # No raw logs leave this process. A positive no-leak result requires
            # actual server logs, including verbose failures and cancellation.
            end_marker = 'PGP_PROTOTYPE_LOG_END_' + uuid.uuid4().hex
            server_markers.append(end_marker.encode())
            sql("SELECT '" + end_marker + "';")
            logs = process(['docker', 'logs', args.container_id])
            require(logs.returncode == 0, 'LOG_READ')
            check_logs(logs.stdout + logs.stderr, b'\n'.join(client_outputs), known_secrets, server_markers)
            checks.append('client_and_server_logs_no_plaintext_or_verifier')
    finally:
        sql("DROP SCHEMA crm_pgp_probe CASCADE; DROP ROLE crm_pgp_probe_worker; DROP EXTENSION pgcrypto;")
    print(json.dumps({'status': 'PASSED_SYNTHETIC_NOLOGIN_ONLY', 'postgres_version': 170010, 'checks': checks, 'production_access': False, 'login_transition_tested': False}))


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        code = str(e)
        raise SystemExit(code if re.fullmatch(r'PGP_PROTOTYPE_[A-Z_]+', code) else 'PGP_PROTOTYPE_UNCONFIRMED')
