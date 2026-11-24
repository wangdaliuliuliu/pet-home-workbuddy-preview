import {query} from './store.js'
import {ensureRunning} from './app.js'
import {withWindow,sleep} from './cdp.js'
import * as dom from './dom.js'
import {projectLabel,writeBinding} from './routing.js'
const fail=(code,text)=>Object.assign(new Error(text),{code})
const db=options=>({dbPath:options.dbPath,helperPath:options.helperPath})
export async function listProjects(options) {
  const response=await query({op:'spaces'},db(options))
  if(!response.ok)throw fail('PROJECT_DB_UNAVAILABLE',response.error)
  return response.rows
}
export async function sessionProject(options,id) {
  const response=await query({op:'session-space',id},db(options))
  if(!response.ok||!response.row)throw fail('PROJECT_DB_UNAVAILABLE',response.error??'Session no longer exists.')
  return response.row
}
export async function ensureProject(options,caller,binding,{projectName}={}) {
  const all=await listProjects(options)
  let project=all.find(p=>p.id===binding.project?.id)
  const requested=projectLabel({...caller,label:projectName??caller.label},binding.scopeKey)
  if(project) {
    if(projectName!==undefined&&project.name!==requested) {
      await ensureRunning(options)
      await withWindow(options.port,'main',c=>dom.renameProject(c,project.id,requested))
      const actual=(await listProjects(options)).find(p=>p.id===project.id)
      if(actual?.name!==requested)throw fail('PROJECT_RENAME_NOT_VERIFIED','Native project rename has not been observed; no task was sent.')
      project=actual
    }
    binding.project={id:project.id,name:project.name}
    writeBinding(options,binding)
    return binding.project
  }
  // Save intent before UI mutation so a slow observation can be recovered without
  // creating the same native group repeatedly.
  if(binding.projectIntentName!==requested&&!all.some(p=>p.name===binding.projectIntentName))binding.projectIntentName=requested
  binding.projectIntentName??=requested
  writeBinding(options,binding)
  const existing=all.filter(p=>p.name===binding.projectIntentName)
  if(existing.length>1)throw fail('AMBIGUOUS_PROJECT','Several native groups have the mapped project name.')
  project=existing[0]
  if(!project) {
    await ensureRunning(options)
    await withWindow(options.port,'main',c=>dom.createProject(c,binding.projectIntentName))
    const end=Date.now()+8000
    while(Date.now()<end&&!project) {
      const matches=(await listProjects(options)).filter(p=>p.name===binding.projectIntentName)
      if(matches.length>1)throw fail('AMBIGUOUS_PROJECT','Native project creation returned multiple matching groups.')
      project=matches[0]
      if(!project)await sleep(250)
    }
  }
  if(!project)throw fail('PROJECT_NOT_OBSERVED','Project creation may have succeeded; retry ensure to recover the saved project intent.')
  binding.project={id:project.id,name:project.name}
  writeBinding(options,binding)
  return binding.project
}
export async function openProjectTask(options,project) {
  await ensureRunning(options)
  await withWindow(options.port,'main',c=>dom.openNewProjectTask(c,project.id))
  return {ok:true,text:`Opened new task in ${project.name}.`,state:await withWindow(options.port,'main',dom.readState)}
}
export async function ensureMembership(options,sessionId,project) {
  let actual=await sessionProject(options,sessionId)
  if(actual.space_id===project.id)return {verified:true,sessionId,projectId:project.id,changed:false}
  await withWindow(options.port,'main',c=>dom.moveSessionToProject(c,sessionId,project.name))
  const end=Date.now()+6000
  while(Date.now()<end) {
    actual=await sessionProject(options,sessionId)
    if(actual.space_id===project.id)return {verified:true,sessionId,projectId:project.id,changed:true}
    await sleep(250)
  }
  throw fail('PROJECT_ASSIGNMENT_NOT_VERIFIED',`Task ${sessionId} was sent but its native project assignment has not been observed. Do not resend.`)
}
