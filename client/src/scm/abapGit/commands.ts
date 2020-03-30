import {
  SourceControlResourceGroup,
  SourceControlResourceState,
  SourceControl,
  Memento,
  window
} from "vscode"
import { command, AbapFsCommands } from "../../commands"
import {
  refresh,
  fromSC,
  AgResState,
  isAgResState,
  fromData,
  UNSTAGED,
  STAGED,
  ScmData,
  fileUri
} from "./scm"
import {
  after,
  log,
  simpleInputBox,
  chainTaskTransformers,
  fieldReplacer,
  withp,
  createTaskTransformer,
  createStore,
  inputBox
} from "../../lib"
import { map, isNone, none, fromEither, isSome } from "fp-ts/lib/Option"
import { getServer } from "../../adt/AdtServer"
import { repoCredentials } from "./credentials"
import { GitStagingFile, GitStaging } from "abap-adt-api"
import { context } from "../../extension"

let commitStore: Memento
const getStore = () => {
  if (!commitStore)
    commitStore = createStore("abapGitRepoCommit", context.globalState)
  return commitStore
}
const transfer = (
  source: SourceControlResourceGroup,
  target: SourceControlResourceGroup,
  items: SourceControlResourceState[]
) => {
  target.resourceStates = [...target.resourceStates, ...items]
  source.resourceStates = source.resourceStates.filter(
    x => !items.find(y => y.resourceUri.toString() === x.resourceUri.toString())
  )
}

const getCommitDetails = async (data: ScmData) => {
  const cred = await repoCredentials(data, true)
  if (isNone(cred)) return none
  const repoid = `${data.connId}_${data.repo.sapPackage}`
  const { committer = "", committerEmail = cred.value.user } =
    getStore().get(repoid) || {}
  const comment = data.scm.inputBox.value
  const commitdata = { ...cred.value, name: "", email: "", comment }
  const validateInput = (x: string) => (x ? null : "Field is mandatory")
  const getUser = inputBox({
    prompt: "Committer user",
    value: committer,
    validateInput
  })
  const getEmail = simpleInputBox("Committer email", committerEmail)
  const getComment = inputBox({ prompt: "Commit comment", validateInput })

  return fromEither(
    await chainTaskTransformers<typeof commitdata>(
      fieldReplacer("comment", getComment, x => !x.comment),
      fieldReplacer("name", getUser),
      fieldReplacer("email", getEmail),
      createTaskTransformer(c => {
        if (!(c.comment && c.email && c.name)) throw none // will be ignored
        getStore().update(repoid, {
          committer: c.name,
          committerEmail: c.email
        })
        return c
      })
    )(commitdata)()
  )
}

const toCommit = (data: ScmData) => {
  if (!data.staging || !data.groups.get(STAGED).resourceStates.length) return

  const all =
    (data.staging && [...data.staging.unstaged, ...data.staging.staged]) || []
  const toPush: GitStaging = {
    ...data.staging,
    staged: [],
    unstaged: []
  }

  const staged = data.groups.get(STAGED).resourceStates
  const inStaged = (f: GitStagingFile) => {
    const target = fileUri(f).toString()
    return !!staged.find(s => s.resourceUri.toString() === target)
  }
  // sort objects and files
  for (const obj of all) {
    const sf: GitStagingFile[] = []
    const uf: GitStagingFile[] = []
    for (const f of obj.abapGitFiles)
      if (inStaged(f)) sf.push(f)
      else uf.push(f)
    if (sf.length) toPush.staged.push({ ...obj, abapGitFiles: sf })
    if (uf.length) toPush.unstaged.push({ ...obj, abapGitFiles: uf })
  }

  return toPush
}

const findSC = () => (target: any, propertyKey: string) => {
  target[propertyKey] = (x: SourceControl) => {
    const y = map(target[propertyKey])(fromSC(x))
    if (isSome(y)) return y.value
  }
}

export class GitCommands {
  @command(AbapFsCommands.agitRefresh)
  @findSC()
  private static async refreshCmd(data: ScmData) {
    return withp(`Refreshing ${data.repo.sapPackage}`, () => refresh(data))
  }
  @command(AbapFsCommands.agitPush)
  @findSC()
  private static async pushCmd(data: ScmData) {
    const toPush = toCommit(data)
    if (!toPush) return
    const details = await getCommitDetails(data)
    if (isNone(details)) return
    const { user, password, name, email, comment } = details.value
    toPush.author = { name, email }
    toPush.committer = { name, email }
    toPush.comment = comment
    const client = getServer(data.connId).client
    try {
      await withp("Committing...", async () => {
        await client.pushRepo(data.repo, toPush, user, password)
      })
      window.showInformationMessage(
        "Commit started. A refresh will be attempted in a few seconds",
        "Ok"
      )
      after(15000).then(() => refresh(data))
    } catch (error) {
      throw new Error(`Error during commit:${error.toString()}`)
    }
  }
  @command(AbapFsCommands.agitPullScm)
  @findSC()
  private static async pullCmd(data: ScmData) {
    log("not yet implemented...")
  }

  @command(AbapFsCommands.agitAdd)
  private static async addCmd(
    ...args: AgResState[] | SourceControlResourceGroup[]
  ) {
    const unstaged = args[0]
    if (isAgResState(unstaged)) {
      const data = unstaged.data
      const states = args as AgResState[]
      transfer(data.groups.get(UNSTAGED), data.groups.get(STAGED), states)
    } else {
      const data = fromData(unstaged)
      if (data)
        transfer(unstaged, data.groups.get(STAGED), unstaged.resourceStates)
    }
  }

  @command(AbapFsCommands.agitRemove)
  private static async removeCmd(
    ...args: AgResState[] | SourceControlResourceGroup[]
  ) {
    const staged = args[0]
    if (isAgResState(staged)) {
      const data = staged.data
      const states = args as AgResState[]
      transfer(data.groups.get(STAGED), data.groups.get(UNSTAGED), states)
    } else {
      const data = fromData(staged)
      if (data)
        transfer(staged, data.groups.get(UNSTAGED), staged.resourceStates)
    }
  }

  @command(AbapFsCommands.agitresetPwd)
  private static async resetCmd() {
    log("not yet implemented...")
  }
}