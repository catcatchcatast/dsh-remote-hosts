import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {lstatSync} from 'node:fs';
import {FORMAL_RC2_CLIENT_SHA256,patchProjectOrder} from '../packages/ui-workspace-menu-compat-rc1/src/patch-project-order.mjs';

const sha256=value=>createHash('sha256').update(value).digest('hex');
const samePath=(left,right)=>left.toLowerCase() === right.toLowerCase();

export function buildRc2WorkspaceCandidate({sourcePath,outputPath,manifestPath=undefined}={}) {
  if (typeof sourcePath !== 'string' || typeof outputPath !== 'string' || sourcePath === '' || outputPath === '') throw new Error('RC2_WORKSPACE_PATHS_REQUIRED');
  sourcePath=resolve(sourcePath); outputPath=resolve(outputPath);
  manifestPath=resolve(manifestPath ?? `${outputPath}.manifest.json`);
  if (samePath(sourcePath,outputPath) || samePath(sourcePath,manifestPath) || samePath(outputPath,manifestPath)) throw new Error('OFFICIAL_WORKSPACE_REPLACEMENT_REFUSED');
  if (lstatSync(outputPath,{throwIfNoEntry:false})?.isSymbolicLink() || lstatSync(manifestPath,{throwIfNoEntry:false})?.isSymbolicLink()) throw new Error('CANDIDATE_LINKED_OUTPUT_REFUSED');
  const source=readFileSync(sourcePath,'utf8');
  const sourceSha256=sha256(source);
  if (sourceSha256 !== FORMAL_RC2_CLIENT_SHA256) throw new Error('RC2_WORKSPACE_SOURCE_HASH_MISMATCH');
  const output=patchProjectOrder(source);
  mkdirSync(dirname(outputPath),{recursive:true});
  mkdirSync(dirname(manifestPath),{recursive:true});
  writeFileSync(outputPath,output);
  const manifest={releaseStatus:'candidate',runtimeVersion:'0.1.5-rc.2',packageName:'@deepseek-ai/dsh-client-ui-workspace',sourceSha256,outputSha256:sha256(output),transformer:'dsh-ui-workspace-menu-compat-rc1/patchProjectOrder'};
  writeFileSync(manifestPath,`${JSON.stringify(manifest,null,2)}\n`);
  return {sourcePath,outputPath,manifestPath,...manifest};
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const [sourcePath,outputPath,manifestPath]=process.argv.slice(2);
  try {
    const result=buildRc2WorkspaceCandidate({sourcePath,outputPath,manifestPath});
    console.log(JSON.stringify({releaseStatus:result.releaseStatus,runtimeVersion:result.runtimeVersion,outputPath:result.outputPath,manifestPath:result.manifestPath,outputSha256:result.outputSha256}));
  } catch (error) {
    const code=typeof error?.message === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.message) ? error.message : 'RC2_WORKSPACE_BUILD_FAILED';
    console.error(JSON.stringify({releaseStatus:'failed',code}));
    process.exitCode=1;
  }
}
