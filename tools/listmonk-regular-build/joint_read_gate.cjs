'use strict';
// Original READ evidence gates isolated validation only; never deployment or sending.
const HASH = /^[a-f0-9]{64}$/;
const fail = () => { throw Error('JOINT_READ_GATE_REFUSED'); };
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const exact = (v, keys) => {
  if (!object(v) || Object.keys(v).sort().join() !== [...keys].sort().join()) fail();
};
const integer = (n, max = 2147483647) => Number.isSafeInteger(n) && n >= 0 && n <= max;
const yes = (v, keys) => { for (const k of keys) if (v[k] !== true) fail(); };
function validateJointRead(report, expected) {
  exact(expected, ['schema', 'kernelSha256', 'countReadSha256', 'recipientReadSha256', 'payloadSha256']);
  if (typeof expected.schema !== 'string' || !/^batch-v[0-9]+-native-joint-worker-budget-read$/.test(expected.schema)) fail();
  for (const k of ['kernelSha256', 'countReadSha256', 'recipientReadSha256', 'payloadSha256']) if (!HASH.test(expected[k])) fail();
  if (!object(report) || report.schema !== expected.schema || report.kernelSha256 !== expected.kernelSha256 || report.payloadSha256 !== expected.payloadSha256) fail();
  yes(report, ['completed', 'readOnly', 'recipientPreviewOnly', 'recipientSectionComplete']);
  for (const k of ['operational', 'runtimeChanged', 'campaignsChanged', 'functionsChanged', 'originalPerformanceAccepted', 'fullRecipientDispatchProved', 'replayAllowed']) if (report[k] !== false) fail();
  if (report.reason !== undefined || report.statementTimeoutMs !== 9000 || report.actualWorkerStatementBudgetMs !== 10000 || report.transportExitCode !== 0 || report.transportStderrPresent !== false || report.transportStderrBytes !== 0) fail();
  if (!Array.isArray(report.results) || report.results.length !== 3) fail();
  for (const [i, row] of report.results.entries()) {
    if (!object(row) || row.stage !== (i === 0 ? 'joint-source-count' : 'recipient-preview') || row.campaignId !== [0, 171, 174][i] || row.sqlState !== '00000' || row.sourceQuerySha256 !== (i === 0 ? expected.countReadSha256 : expected.recipientReadSha256)) fail();
    if (!Number.isFinite(row.elapsedMs) || row.elapsedMs < 0 || row.elapsedMs > 9000 || row.stderrPresent !== false || row.stderrBytes !== 0) fail();
    yes(row, ['rollbackAndProcessEndConfirmed', 'jitLocalOffRequested', 'contextUnchanged', 'jitLocalOffConfirmed']);
    if (row.sourceVariant !== null) fail();
    const a = row.aggregate;
    if (i === 0) {
      yes(row, ['jointStatement171174', 'actualMatchedMaxCapturedPrivately', 'actualListArgumentsCapturedPrivately']);
      exact(a, ['stage', 'campaignIds', 'rowCount', 'campaignShape', 'counts']);
      if (a.stage !== 'joint-source-count' || a.rowCount !== 2 || a.campaignShape !== true || !Array.isArray(a.campaignIds) || a.campaignIds.length !== 2 || a.campaignIds[0] !== 171 || a.campaignIds[1] !== 174 || !Array.isArray(a.counts) || a.counts.length !== 2) fail();
      for (const [j, count] of a.counts.entries()) {
        exact(count, ['campaignId', 'toSend', 'maxSubscriberIdShape']);
        if (count.campaignId !== [171, 174][j] || !integer(count.toSend) || count.maxSubscriberIdShape !== true) fail();
      }
    } else {
      yes(row, ['actualMatchedMaxAndListLiteralsBound', 'countContextUnchanged']);
      exact(a, ['stage', 'campaignId', 'rowCount', 'chosenCount', 'chosenShape', 'deliverySnapshotShape', 'withinLimit', 'fullRecipientQueryClosed']);
      if (a.stage !== 'recipient-preview' || a.campaignId !== row.campaignId || a.rowCount !== 1 || !integer(a.chosenCount, 1)) fail();
      yes(a, ['chosenShape', 'deliverySnapshotShape', 'withinLimit', 'fullRecipientQueryClosed']);
    }
    // Private SELECT arguments/context digests stay in the executor's RAM.
    const allowed = ['stage', 'campaignId', 'sourceVariant', 'elapsedMs', 'sqlState', 'rollbackAndProcessEndConfirmed', 'stderrPresent', 'stderrBytes', 'jitLocalOffRequested', 'contextUnchanged', 'jitLocalOffConfirmed', 'aggregate', 'sourceQuerySha256', ...(i === 0 ? ['jointStatement171174', 'actualMatchedMaxCapturedPrivately', 'actualListArgumentsCapturedPrivately'] : ['actualMatchedMaxAndListLiteralsBound', 'countContextUnchanged'])];
    exact(row, allowed);
  }
  return Object.freeze({jointCountReadAccepted:true, wholeRecipientPreviewReadAccepted:true, originalPerformanceAccepted:false, fullRecipientDispatchProved:false, originalAuthorityAccepted:false, operational:false});
}
module.exports = Object.freeze({validateJointRead});
