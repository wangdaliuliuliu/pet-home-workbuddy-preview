const str = (description) => ({ type: 'string', minLength: 1, description })
const num = (description, minimum = 0, maximum = 3600) => ({ type: 'number', minimum, maximum, description })
const session = str('Exact session id, unambiguous id prefix/title, or new. Historical operations verify the selected session.')
const settings = {
  model: str('Model display name from workbuddy_models.'),
  effort: { type: 'string', enum: ['关闭', '低', '中', '高', '超高'] },
  contextK: num('Context K offered by the selected model; 0 means its maximum.', 0, 100000),
  expert: str('Expert display name. New tasks only; unsupported configuration fails before sending.'),
}
const routing = {
  callerConversationId: str('Stable calling Codex/Work conversation id. Defaults to per-request caller metadata or CODEX_THREAD_ID/CODEX_SESSION_ID; never infer from the MCP server cwd.'),
  callerProjectKey: str('Optional stable caller project id or canonical project path. Same key shares one native WB group; each calling conversation keeps its own last task.'),
  callerProjectName: str('Readable caller project name for the initial WB project name.'),
  callerConversationTitle: str('Readable caller conversation title when no caller project is supplied.'),
  projectName: str('Desired readable mapped project name; explicit changes rename the managed WB group.'),
  relationship:{type:'string',enum:['auto','related','unrelated','different-project','same-project'],description:'Calling agent semantic routing decision. Default auto prefers the last task unless clearly disjoint. unrelated starts a task in the same WB project; different-project creates a topic branch.'},
  topicKey:str('Stable topic key for different-project branch routing.'),
  taskKind:{type:'string',enum:['code','general'],description:'Optional task classification. Code tasks default to expert 吴八哥 (高级开发工程师).'},
  routing:{type:'string',enum:['auto','manual'],default:'auto',description:'Auto maps caller projects/conversations and reuses tasks; manual intentionally bypasses mapping.'},
}
const collection = {
  outputDir: str('Absolute folder for an optional summary; files stay at their source unless mode is copy.'),
  mode: { type: 'string', enum: ['auto', 'copy'], default: 'auto' },
  allowedOutputDirs: { type: 'array', items: { type: 'string' }, description: 'Explicit source output directories. Required for copy; files outside these roots are not copied.' },
}
function tool(name, description, properties, required = [], readOnlyHint = false) {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false }, annotations: { readOnlyHint, destructiveHint: !['workbuddy_sessions','workbuddy_wait','workbuddy_recover','workbuddy_collect','workbuddy_watch'].includes(name), idempotentHint: readOnlyHint, openWorldHint: name === 'workbuddy_run' || name === 'workbuddy_send' } }
}
export const catalogue = [
  tool('workbuddy_status', 'Observe with launch=false (default). launch=true starts the app; a running app with no debug port is forcibly relaunched under the configured user policy.', { launch: { type: 'boolean', default: false }, restart: { type: 'boolean', default: false } }),
  tool('workbuddy_sessions', 'Read WorkBuddy session metadata from its SQLite database without starting the app.', { query: str('Title filter.'), limit: { type: 'integer', minimum: 1, maximum: 200, default: 20 } }, [], true),
  tool('workbuddy_models', 'Read the live model menu. Opens the menu in the local WorkBuddy window.', {}),
  tool('workbuddy_experts', 'Read the live expert market in the local WorkBuddy window.', { query: str('Name or role filter.') }),
  tool('workbuddy_open', 'Open an unambiguous historical session or the new-task view. Prefer workbuddy_run for an atomic complete workflow.', { session }),
  tool('workbuddy_project','Inspect/ensure/rename the caller-mapped native WB project (UI group/space), or repair a sent dispatch project assignment. Defaults to read-only get.',{action:{type:'string',enum:['get','ensure','rename','attach'],default:'get'},...routing,dispatchId:str('Required for attach; must belong to this caller mapping.')}),
  tool('workbuddy_configure', 'Configure an explicit target. Omitted settings default to Hy4/high/300K; code taskKind adds 吴八哥. Explicit settings must succeed.', { session, ...settings,taskKind:routing.taskKind }, ['session']),
  tool('workbuddy_send', 'Map the caller to a WB project and prefer its previous task; omitted settings use Hy4/high/300K, code tasks use 吴八哥. Clear expert prefills and submit once with a durable ticket.', { session,...routing,...settings, task: str('Authorized task to execute in WorkBuddy.'), requestId: str('Caller retry key. Reusing it never sends another copy of the same task.'), waitSeconds: num('Optional completion wait. Zero returns the dispatch ticket.') }, ['task']),
  tool('workbuddy_wait', 'Wait for a dispatchId or explicit session. Default budget 30 seconds; waiting is not failure and never cancels the task.', { dispatchId: str('Durable dispatch id.'), sessionId: str('Target session id/prefix/title.'), timeoutSec: num('Wait budget in seconds.', 0.1), evidence: { type: 'object', description: 'Original evidence; prefer dispatchId so callers cannot accidentally rewrite it.' } }),
  tool('workbuddy_watch', 'Start a small background monitor for an existing dispatch, inspect its state, or read its saved result. It observes WorkBuddy without opening or restarting the app.', { dispatchId: str('Durable dispatch id.'), action: { type: 'string', enum: ['start', 'status', 'result'], default: 'start' }, timeoutSec: num('Maximum background observation time in seconds; default 1800.', 1, 14400) }, ['dispatchId']),
  tool('workbuddy_recover', 'Recover/bind an existing dispatch to its verified session and user turn. Never sends a message. Legacy 2.0 evidence can be explicitly imported after transcript validation.', { dispatchId: str('Durable dispatch id.'), sessionId: str('Optional recovered exact session id.'), evidence: { type: 'object', description: 'Original 2.0 failed-send evidence, only for legacy import.' } }),
  tool('workbuddy_cancel', 'Interrupt only a verified dispatch on its exact session and user turn; never kills the app. Returns requested and confirmed separately.', { dispatchId: str('Dispatch to interrupt.') }, ['dispatchId']),
  tool('workbuddy_collect', 'Read answer and candidate file paths for an explicit session; optionally write a summary or copy files without overwriting collisions.', { sessionId: str('Target session id/prefix/title.'), ...collection, sinceMs: num('Optional timestamp lower bound for modified-file candidates.', 0, Number.MAX_SAFE_INTEGER) }, ['sessionId']),
  tool('workbuddy_run', 'Auto-create/name a WB project for the caller; prefer that conversation’s previous task unless low relevance. Defaults Hy4/high/300K and 吴八哥 for code. Submit once, then wait up to 30s; recover/wait/cancel by dispatchId.', { task: str('Authorized task to execute in WorkBuddy.'), requestId: str('Stable caller retry key.'), session,...routing, ...settings, ...collection, timeoutSec: num('Wait budget in seconds.', 0.1), restart: { type: 'boolean', default: false } }, ['task']),
]

