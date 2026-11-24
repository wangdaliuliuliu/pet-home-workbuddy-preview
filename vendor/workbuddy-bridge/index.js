import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as flow from './lib/flow.js'
import { withLock } from './lib/lock.js'
import { existingRequest, taskHash } from './lib/dispatch.js'
import {executionDefaults,scopeRequest} from './lib/routing.js'

import { catalogue } from './lib/tools.js'
import { watch } from './lib/watch.js'

export function loadConfig(env = process.env) {
  const config = env.WORKBUDDY_BRIDGE_CONFIG ? JSON.parse(fs.readFileSync(env.WORKBUDDY_BRIDGE_CONFIG, 'utf8')) : {}
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw invalid('configuration must be an object')
  if (env.WORKBUDDY_CDP_PORT) config.port = Number(env.WORKBUDDY_CDP_PORT)
  if (env.WORKBUDDY_DB) config.dbPath = env.WORKBUDDY_DB
  if (env.WORKBUDDY_EXE) config.appPath = env.WORKBUDDY_EXE
  if (env.WORKBUDDY_BRIDGE_LOCK) config.lockPath = env.WORKBUDDY_BRIDGE_LOCK
  return config
}

function invalid(message) { return Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' }) }
export function validateArguments(schema, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw invalid('arguments must be an object')
  for (const key of schema.required ?? []) if (args[key] === undefined) throw invalid(`${key} is required`)
  for (const [key, value] of Object.entries(args)) {
    const rule = schema.properties[key]
    if (!rule) throw invalid(`Unknown argument: ${key}`)
    const correctType = rule.type === 'array' ? Array.isArray(value) && value.every(v=>typeof v==='string' && path.isAbsolute(v)) : rule.type === 'integer' ? Number.isInteger(value) : rule.type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : typeof value === rule.type
    if (!correctType || typeof value === 'number' && !Number.isFinite(value)) throw invalid(`${key} must be ${rule.type}`)
    if (typeof value === 'string' && rule.minLength && !value.trim()) throw invalid(`${key} must not be empty`)
    if (rule.enum && !rule.enum.includes(value)) throw invalid(`${key} must be one of ${rule.enum.join(', ')}`)
    if (rule.minimum !== undefined && value < rule.minimum || rule.maximum !== undefined && value > rule.maximum) throw invalid(`${key} is out of range`)
  }
  if (args.outputDir && !path.isAbsolute(args.outputDir)) throw invalid('outputDir must be absolute')
  if (args.mode === 'copy' && !args.outputDir) throw invalid('mode copy requires outputDir')
  if (args.mode === 'copy' && !args.allowedOutputDirs?.length) throw invalid('copy requires explicit allowedOutputDirs source roots')
  if (args.restart && args.launch === false) throw invalid('restart requires launch=true')
  if(args.action==='attach'&&!args.dispatchId)throw invalid('attach requires dispatchId')
  if(args.action==='rename'&&!args.projectName)throw invalid('rename requires projectName')
}

export function createBridge(config = {}) {
  if (config.port !== undefined && (!Number.isInteger(Number(config.port)) || Number(config.port) < 1 || Number(config.port) > 65535)) throw invalid('port must be between 1 and 65535')
  const baseRuntime = flow.resolveOptions({ ...config, autoRestart: config.autoRestart !== false })
  if (!Number.isInteger(baseRuntime.port) || baseRuntime.port < 1 || baseRuntime.port > 65535) throw invalid('port must be between 1 and 65535')
  const lockPath = config.lockPath ?? path.join(process.env.WORKBUDDY_HOME ?? path.join(os.homedir(), '.workbuddy'), 'bridge-locks', `cdp-${baseRuntime.port}.lock`)
  return {
    listTools: () => structuredClone(catalogue),
    async callTool(name, args = {}, callContext={}) {
      const runtime={...baseRuntime,...Object.fromEntries(['callerConversationId','callerProjectKey','callerProjectName','callerConversationTitle'].filter(k=>typeof callContext[k]==='string'&&callContext[k].trim()).map(k=>[k,callContext[k]]))}
      let lastDispatch = args.dispatchId ? {dispatchId:args.dispatchId,sessionId:args.sessionId} : undefined
      try {
        const definition = catalogue.find(t => t.name === name)
        if (!definition) throw Object.assign(new Error(`Unknown tool: ${name}`), { code: 'UNKNOWN_TOOL' })
        validateArguments(definition.inputSchema, args)
        if (name === 'workbuddy_wait' && !args.dispatchId && !args.sessionId) throw invalid('dispatchId or sessionId is required')
        const execute = async () => {
          if(['workbuddy_run','workbuddy_send'].includes(name))args=scopeRequest(args,runtime)
          if (['workbuddy_run','workbuddy_send'].includes(name) && args.requestId) {
            const prior = existingRequest(runtime, args.requestId)
            if (prior) {
              if (prior.taskHash !== taskHash(args.task)) throw Object.assign(new Error('requestId already belongs to another task.'), { code: 'REQUEST_CONFLICT' })
              return flow.recover(runtime, { dispatchId: prior.dispatchId })
            }
          }
          let result
          switch (name) {
            case 'workbuddy_status': result = await flow.status(runtime, { launch: args.launch === true || args.restart === true, restart: args.restart === true }); break
            case 'workbuddy_sessions': result = await flow.history(runtime, args); break
            case 'workbuddy_models': result = await flow.models(runtime); break
            case 'workbuddy_experts': result = await flow.experts(runtime, args); break
            case 'workbuddy_open': result = await flow.open(runtime, args); break
            case 'workbuddy_project': result = await flow.projectControl(runtime,args);break
            case 'workbuddy_configure': {
              const opened = await flow.open(runtime, { session: args.session })
              if (!opened.ok) throw new Error(opened.text ?? 'Could not open the target session')
              result = await flow.configure(runtime, executionDefaults(args)); break
            }
            case 'workbuddy_send': {
              result=await flow.run(runtime,args,{sendOnly:true})
              lastDispatch={dispatchId:result.dispatchId,sessionId:result.sessionId,evidence:result.evidence,submitted:result.ok}
              break
            }
            case 'workbuddy_wait': {
              const waited = await flow.waitForRun(runtime, args)
              if (!waited.done) { result = { ok: true, status: waited.needsRecovery ? 'pending-observation' : 'waiting', done: false, text: 'Wait budget elapsed; task is not cancelled. Continue with the dispatch ticket.', waited, sessionId: waited.sessionId, dispatchId: args.dispatchId ?? args.evidence?.dispatchId, evidence: args.evidence }; break }
              const collected = await flow.collect(runtime, { sessionId: waited.sessionId, since: args.evidence?.since, answer: args.evidence || args.dispatchId ? waited.turn.answer ?? '' : undefined })
              result = { ok: waited.done && waited.status === 'completed', text: `${waited.done ? waited.status : 'timeout; task may still be running'}\n${collected.text}`, waited, collected }; break
            }
            case 'workbuddy_watch': result = await watch(runtime, args); break
            case 'workbuddy_recover': result = await flow.recover(runtime, args); break
            case 'workbuddy_cancel': result = await flow.cancel(runtime, args); break
            case 'workbuddy_collect': result = await flow.collect(runtime, { ...args, since: args.sinceMs }); break
            case 'workbuddy_run': result = await flow.run(runtime, args); break
          }
          return result
        }
        // Read/observe operations do not queue behind a long run. A separately guarded
        // cancel can reach the stop control while that run is only polling SQLite.
        if (name === 'workbuddy_cancel') return await withLock(`${lockPath}.cancel`, execute)
        if (['workbuddy_sessions','workbuddy_wait','workbuddy_collect','workbuddy_recover','workbuddy_watch'].includes(name)) return await execute()
        return await withLock(lockPath, execute)
      } catch (error) {
        return { ...lastDispatch, ok: false, code: error.code ?? 'BRIDGE_ERROR', text: error.message ?? String(error), details: error.details }
      }
    },
  }
}
