import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex')
const fail = (code, text) => Object.assign(new Error(text), {code})
export function callerContext(args={}, options={}, env=process.env) {
  const conversationId=args.callerConversationId ?? options.callerConversationId ?? (options.callerContextSource==='mcp'?undefined:env.CODEX_THREAD_ID??env.CODEX_SESSION_ID)
  if (typeof conversationId!=='string'||!conversationId.trim()) throw fail('CALLER_CONTEXT_REQUIRED','Auto routing requires a stable callerConversationId. CLI may use CODEX_THREAD_ID; MCP must pass per-call identity, since its server may be shared. Never use the server cwd or a shared global key.')
  if(['__proto__','constructor','prototype'].includes(conversationId))throw fail('INVALID_ARGUMENT','Invalid callerConversationId.')
  let projectKey=args.callerProjectKey ?? options.callerProjectKey ?? (options.callerContextSource==='mcp'?undefined:env.CODEX_PROJECT_ID)
  if(projectKey!==undefined&&typeof projectKey!=='string')throw fail('INVALID_ARGUMENT','callerProjectKey must be a string.')
  if(projectKey&&/^(?:[a-z]:[\\/]|\\\\)/i.test(projectKey))projectKey=path.win32.normalize(projectKey).replace(/[\\/]+$/,'').toLowerCase()
  const baseScope=projectKey ? `project:${projectKey}` : `conversation:${conversationId}`
  const label=args.projectName ?? args.callerProjectName ?? args.callerConversationTitle ?? options.callerProjectName ?? options.callerConversationTitle ?? `会话 ${conversationId.slice(0,8)}`
  return {conversationId,projectKey,baseScope,label:String(label).trim().slice(0,70)}
}
function file(options,key) { return path.join(options.routingDir ?? path.join(path.dirname(options.dbPath),'bridge-routing'),`${hash(key)}.json`) }
export function readBinding(options,key) {
  try { return JSON.parse(fs.readFileSync(file(options,key),'utf8')) }
  catch(e) { if(e.code==='ENOENT')return {scopeKey:key,threads:{},createdAt:Date.now()};throw e }
}
export function writeBinding(options,binding) {
  const target=file(options,binding.scopeKey)
  fs.mkdirSync(path.dirname(target),{recursive:true})
  const temp=`${target}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temp,JSON.stringify({...binding,updatedAt:Date.now()}),{flag:'wx',mode:0o600})
  fs.renameSync(temp,target)
  return binding
}
export function projectLabel(caller,scope=caller.baseScope) {
  // WorkBuddy applies a weighted name-length limit (CJK costs more than ASCII).
  // Keep a conservative 20-unit name, including a stable collision suffix.
  let short='',units=0
  for(const ch of String(caller.label).replace(/[\\/:*?"<>|\r\n]/g,'_')) {
    const cost=ch.codePointAt(0)>127?2:1
    if(units+cost>13)break
    short+=ch;units+=cost
  }
  return `${short.trim()||'Codex'}-${hash(scope).slice(0,6)}`
}
export function taskKeywords(task) {
  const text=String(task).toLowerCase()
  const words=text.match(/[a-z][a-z0-9_.-]{2,}/g)??[]
  for(const part of text.match(/[\u4e00-\u9fff]{2,}/g)??[]) for(let i=0;i<part.length-1;i++)words.push(part.slice(i,i+2))
  const stop=new Set(['task','please','this','that','with','from','需要','这个','任务','一下','请帮','继续','进行','完成','项目'])
  return [...new Set(words.filter(w=>!stop.has(w)))].slice(0,120).map(word=>hash(word).slice(0,16))
}
export function inferTaskKind(task) {
  return /代码|编程|源码|函数|调试|重构|单元测试|接口|数据库|脚本|插件|软件开发|前端|后端|仓库|程序|\b(code|coding|bug|debug|refactor|api|sql|python|javascript|typescript|repository|implementation)\b|\.(py|js|mjs|ts|tsx|java|cpp|go)\b/i.test(task) ? 'code' : 'general'
}
export function executionDefaults(args={}) {
  const taskKind=args.taskKind ?? inferTaskKind(args.task??'')
  return {...args,taskKind,model:args.model??'Hy4',effort:args.effort??'高',contextK:args.contextK??300,expert:args.expert??(taskKind==='code'?'吴八哥':undefined)}
}
export function scopeForCall(options,caller,args={}) {
  const base=readBinding(options,caller.baseScope)
  const previous=base.threads[caller.conversationId]
  let key=args.relationship==='same-project'?caller.baseScope:previous?.activeScope??caller.baseScope
  if(args.relationship==='different-project') key=`${caller.baseScope}/topic:${args.topicKey??hash(taskKeywords(args.task).join('|')).slice(0,16)}`
  return {base,key,binding:key===base.scopeKey?base:readBinding(options,key)}
}
export function scopeRequest(args,options) {
  if(!args.requestId||args.routing==='manual'||args._requestNamespaced)return args
  const caller=callerContext(args,options)
  const scope=scopeForCall(options,caller,args).key
  return {...args,requestId:`caller:${hash(`${caller.conversationId}|${scope}`)}:${args.requestId}`,_requestNamespaced:true}
}
export function chooseSession(binding,caller,args={}) {
  const previous=binding.threads[caller.conversationId]
  if(args.session && args.session!=='auto') return {session:args.session,reason:'explicit-session'}
  if(!previous?.lastSessionId)return {session:'new',reason:'first-call-in-conversation'}
  if(['unrelated','different-project'].includes(args.relationship))return {session:'new',reason:'caller-declared-low-relevance'}
  if(args.expert && previous.expert!==args.expert)return {session:'new',reason:'expert-requires-new-task'}
  const current=taskKeywords(args.task)
  const old=previous.taskKeywords??[]
  const intersection=current.filter(word=>old.includes(word)).length
  const similarity=(current.length+old.length)?2*intersection/(current.length+old.length):null
  // Lexical evidence only handles clearly disjoint topics. The calling agent can
  // supply an explicit semantic relationship; short follow-ups favor continuity.
  const explicitlyRelated=args.relationship==='related'
  const refersBack=/^(继续|接着|然后|此外|另外|上次|这个|同一|再|针对|补充|修改|请继续|请接着)/.test(String(args.task).trim()) || /^(continue|follow[ -]?up|also|then)\b/i.test(String(args.task).trim())
  if(!explicitlyRelated&&!refersBack&&current.length>=8&&old.length>=8&&similarity<0.035)return {session:'new',reason:'very-low-lexical-overlap',similarity}
  return {session:previous.lastSessionId,reason:explicitlyRelated?'caller-declared-related':'prefer-last-task-in-conversation',similarity}
}
export function rememberCall(options,caller,scope,binding,args,result) {
  const existing=binding.threads[caller.conversationId]??{}
  const fresh=args.resolvedSession==='new'
  binding.threads[caller.conversationId]={...existing,lastSessionId:result.sessionId??(fresh?undefined:existing.lastSessionId),lastDispatchId:result.dispatchId??existing.lastDispatchId,taskKeywords:taskKeywords(args.task),taskKind:args.taskKind,expert:args.expert??(fresh?undefined:existing.expert),lastCallAt:Date.now()}
  writeBinding(options,binding)
  const base=scope===caller.baseScope?binding:readBinding(options,caller.baseScope)
  base.threads[caller.conversationId]={...base.threads[caller.conversationId],activeScope:scope}
  writeBinding(options,base)
}
