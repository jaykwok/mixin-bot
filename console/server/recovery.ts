// Entry decision of the web console: a checkout not deployed yet, or one where only recovery (continue/rollback/diagnose) is possible.
import { deploymentRecord, inspectDataVersion } from "../../src/core/data-version.ts";
import { loadDeployment, PROJECT_DIR } from "../../ops/core/platform.ts";
import { loadPendingTransaction, type PendingTransaction } from "../../ops/core/pending-transaction.ts";

/** 尚未部署的检出：没有未完成的事务、部署记录和运行数据。维护页给出首次部署向导，需要已有部署的操作不显示。 */
export function undeployed(project: string): boolean {
  try { return !loadPendingTransaction(project) && deploymentRecord(project) === null; }
  catch { return false; }
}

/**
 * 入口判断：尚未部署时 `undeployed`（概览引导到维护页的首次部署向导）；只能继续、回滚或诊断时 `recovery` 给出原因（有可读的事务时
 * 到维护页的「部署恢复」处理，否则在终端诊断），否则为 null。
 * 有未完成的事务时先读记录，普通设置损坏也算在内；普通设置留给正常页面加载。
 */
export function entryState(): { undeployed: boolean; recovery: string | null } {
  let pending: PendingTransaction | null;
  try { pending = loadPendingTransaction(); }
  catch (error) { return { undeployed: false, recovery: `事务记录无法读取：${(error as Error).message}` }; }
  if (!pending) {
    // 没有事务时由部署记录决定：没有记录也没有数据是尚未部署；有数据却没有有效记录、记录损坏或格式不受支持时说明原因。
    try { return { undeployed: deploymentRecord(PROJECT_DIR) === null, recovery: null }; }
    catch (error) { return { undeployed: false, recovery: (error as Error).message }; }
  }
  // A first deployment records the data version when it commits: until then (running, or waiting to be continued or rolled
  // back) its own transaction explains the state, shown as the pending deployment rather than as data never deployed.
  try { if (deploymentRecord(PROJECT_DIR) === null) return { undeployed: false, recovery: null }; }
  catch { /* an unreadable record is reported below */ }
  // 正常页面要加载普通设置；损坏时只能先在「部署恢复」里继续或回滚。
  try { loadDeployment(); }
  catch (error) { return { undeployed: false, recovery: `普通设置无法读取（${(error as Error).message}）：先继续或回滚上次操作` }; }
  const state = inspectDataVersion(PROJECT_DIR);
  return { undeployed: false, recovery: state.current ? null : state.detail };
}
