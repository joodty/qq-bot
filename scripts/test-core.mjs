// Portable development gate. All peers and credentials are isolated fixtures.
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const tests=['test-publication.mjs','test-data-model.mjs','test-sqlite-state.mjs','test-console-auth.mjs','test-public-registration.mjs',
 'test-conversation-roles.mjs','test-conversation-sessions.mjs','test-group-mention-only.mjs','test-participation-policy.mjs','test-probability-delivery.mjs',
 'test-bot-manager.mjs','test-management-integration.mjs','test-bot-onboarding.mjs','test-tenant-router.mjs','test-tenant-bridge.mjs',
 'test-group-budget.mjs','test-budget-controller.mjs','test-budget-bridge.mjs'];
let failed=0;
for(const name of tests){console.log('\nRunning '+name);const result=spawnSync(process.execPath,[path.join(root,'scripts',name)],{cwd:root,stdio:'inherit',timeout:60000,env:{...process.env,QQ_BRIDGE_TEST_LIVE:'0'}});if(result.error||result.status!==0){failed++;console.error('FAILED '+name+': '+(result.error?.message||result.status));}}
console.log(`Core suite: ${tests.length-failed}/${tests.length} scripts passed; no production peers.`);if(failed)process.exitCode=1;
