import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;}
async function launch({mock=false,production=false,existingDir}={}){
 const dir=existingDir||await mkdtemp(path.join(os.tmpdir(),'pantrypal-api-')),port=await freePort(),logs=[];
 const env={...process.env,PORT:String(port),HOST:'127.0.0.1',PANTRYPAL_DATA_FILE:path.join(dir,'state.json')};
 if(production)env.NODE_ENV='production';else delete env.NODE_ENV;
 delete env.PANTRYPAL_GEMMA_DISABLED;
 if(mock){env.GOOGLE_AI_API_KEY='fake-test-only';env.NODE_OPTIONS=`--import=${path.join(project,'test-support/mock-gemma.mjs')}`;}else env.PANTRYPAL_GEMMA_DISABLED='1';
 const child=spawn(process.execPath,['server.mjs'],{cwd:project,env,stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',b=>logs.push(b.toString()));child.stderr.on('data',b=>logs.push(b.toString()));
 const base=`http://127.0.0.1:${port}`;
 for(let i=0;i<100;i++){try{await fetch(`${base}/api/status`);break}catch{}if(child.exitCode!==null)throw new Error('PantryPal server exited before readiness');await new Promise(r=>setTimeout(r,60));}
 return {base,dir,logs,child,async call(url,method='GET',body){const r=await fetch(`${base}${url}`,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};},async close({cleanup=true}={}){if(child.exitCode===null){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}if(cleanup)await rm(dir,{recursive:true,force:true});}};
}
const indianStaples=['salt','water','cooking oil','turmeric','red chilli powder','cumin seeds','coriander powder','garam masala','mustard seeds','hing','black pepper','ginger','garlic'];
function assertRecipeShape(recipe,selected){
 assert.ok(recipe.title&&recipe.description);assert.ok(Array.isArray(recipe.ingredients)&&recipe.ingredients.length);assert.ok(Array.isArray(recipe.steps)&&recipe.steps.length);assert.ok(recipe.equipment);assert.ok(Number.isFinite(recipe.timeMinutes));assert.ok(Number.isFinite(recipe.pantryMatch));assert.ok(Number.isFinite(recipe.mealEfficiencyScore));assert.equal(Number.isFinite(recipe.scoreBreakdown.ingredientCoverage),true);
 assert.ok(recipe.pantryUsed.every(n=>selected.includes(n)),'kitchen staples must not count as tracked pantry use');
 assert.ok(recipe.ingredients.filter(i=>i.source==='selected').every(i=>selected.includes(i.name)),'unselected tracked ingredient escaped selection');
 assert.ok(recipe.ingredients.filter(i=>i.source==='kitchen_staple').every(i=>indianStaples.includes(i.name)),'unconfigured staple was generated');
 assert.equal(Number.isFinite(recipe.kitchenMatch),true);assert.equal(Number.isFinite(recipe.matchScore),true);
 for(const value of Object.values(recipe.efficiency))assert.equal(Number.isFinite(value),true);assert.equal(recipe.mealEfficiencyScore,recipe.efficiency.score);assert.equal(recipe.pantryMatch,recipe.kitchenMatch);
 assert.ok(recipe.efficiency.score>=0&&recipe.efficiency.score<=100);assert.doesNotMatch(JSON.stringify(recipe),/undefined|NaN/);
 assert.equal(recipe.efficiency.score,Math.round(recipe.efficiency.wasteSaved*.4+recipe.efficiency.timeEfficiency*.3+recipe.efficiency.coverage*.3));
}
async function addAndGenerate(app,names,opts={}){
 const added=await app.call('/api/pantry','POST',{items:names.map(name=>({name,category:/tomato|spinach|onion|pepper/i.test(name)?'Vegetables':/egg|bean|chickpea|lentil/i.test(name)?'Protein':/oat|rice|pasta|bread/i.test(name)?'Grains':'Dairy'}))});assert.equal(added.status,201);
 const selected=added.data.items.map(i=>i.name);
 const result=await app.call('/api/recipes/generate','POST',{ingredients:added.data.items.map(i=>({id:i.id})),goal:opts.goal||'High protein',cuisine:opts.cuisine||'Indian',time:opts.time||45,equipment:opts.equipment||'One pan',effort:'Easy'});
 assert.equal(result.status,200,`HTTP ${result.status}: ${JSON.stringify(result.data)}\n${app.logs.join('')}`);for(const recipe of result.data.recipes)assertRecipeShape(recipe,selected);
 return {result,selected};
}
function debugPayload(selectedIngredients,equipment,cuisine='Indian',timeMinutes=20){return {selectedIngredients,kitchenStaples:indianStaples,cuisine,equipment,goal:'quick',timeMinutes};}

test('kitchen staple profiles persist independently from tracked pantry',async t=>{
 const app=await launch();t.after(()=>app.close());const initial=await app.call('/api/preferences');assert.equal(initial.data.kitchenProfile,'Indian');assert.ok(initial.data.kitchenStaples.some(x=>x.name==='garam masala'&&x.enabled));
 const changed=await app.call('/api/preferences','PATCH',{kitchenProfile:'Custom',kitchenStaples:[{name:'cumin seeds',enabled:true},{name:'custom zaatar',enabled:false,custom:true}]});assert.equal(changed.data.kitchenProfile,'Custom');assert.equal((await app.call('/api/pantry')).data.items.length,0);
});
test('one Gemma request ranks candidate families and applies deterministic flags',async t=>{
 const app=await launch({mock:true});t.after(()=>app.close());const {result}=await addAndGenerate(app,['tomatoes','paneer'],{equipment:['Stovetop'],time:'30 minutes',goal:'High protein'});const d=result.data;
 assert.equal(d.provider,'gemma');assert.equal(d.requestedCandidates,8);assert.equal(d.receivedCandidates,8);assert.equal(d.returnedCandidates,d.recipes.length);assert.ok(d.recipes.length>=1&&d.recipes.length<=6);assert.equal(new Set(d.recipes.map(r=>r.title)).size,d.recipes.length);assert.equal(d.duplicateCandidates,d.validCandidates-d.returnedCandidates);assert.equal((app.logs.join('').match(/request_started/g)||[]).length,1);
 for(const r of d.recipes){assertRecipeShape(r,['tomatoes','paneer']);assert.ok(r.timeMinutes<=30);assert.ok(r.timeBucket);assert.ok(r.effort);assert.ok(Array.isArray(r.equipment));assert.ok(r.protein?.label);assert.equal(r.protein.gramsEstimate,null);assert.equal(r.generatedBy,'gemma');}
 assert.match(app.logs.join(''),/generation_summary.*"requestedCandidates":8.*"returnedCandidates":\d+/);
});
test('time is passed as a ceiling and actual times remain distinct; no preference has no ceiling',async t=>{
 const app=await launch({mock:true});t.after(()=>app.close());const ten=await addAndGenerate(app,['tomatoes','cheese'],{time:'10 minutes',equipment:['Microwave'],goal:'Quick'});assert.ok(ten.result.data.recipes.length>0);assert.ok(ten.result.data.recipes.every(r=>r.timeMinutes<=10));assert.ok(ten.result.data.recipes.some(r=>r.timeMinutes<10));
 const none=await addAndGenerate(app,['tomatoes','cheese'],{time:'No preference',equipment:['Microwave'],goal:'Surprise me'});assert.ok(none.result.data.recipes.every(r=>Number.isFinite(r.timeMinutes)&&r.timeBucket));
});
test('multiple available equipment lets each candidate choose one compatible method',async t=>{
 const app=await launch({mock:true});t.after(()=>app.close());const {result}=await addAndGenerate(app,['tomatoes','cheese'],{equipment:['Stovetop','Microwave','Oven'],time:'30 minutes',goal:'Surprise me'});const recipes=result.data.recipes;assert.ok(recipes.length>=2);assert.ok(recipes.every(r=>r.equipment.length===1));assert.ok(recipes.every(r=>['Stovetop','Microwave','Oven'].includes(r.equipment[0])));assert.ok(recipes.some(r=>r.equipment[0]==='Microwave'));assert.ok(recipes.some(r=>r.equipment[0]==='Stovetop'));
});
test('unavailable protein ingredients are not invented for a high-protein goal',async t=>{
 const app=await launch({mock:true});t.after(()=>app.close());const {result}=await addAndGenerate(app,['onion','spinach'],{equipment:['Stovetop','Microwave'],time:'30 minutes',goal:'High protein'});assert.ok(result.data.recipes.length);for(const r of result.data.recipes){assert.ok(!['High protein','Good protein'].includes(r.protein.label));assert.equal(r.goalMatch,'Best available match');assert.ok(r.ingredients.every(i=>['onion','spinach',...indianStaples].includes(i.name)));}
});
test('regional cuisine, meal role, and protein labels derive from recipe ingredients',async t=>{
 const app=await launch({mock:true});t.after(()=>app.close());const {result}=await addAndGenerate(app,['spinach','paneer'],{equipment:['Stovetop'],time:'20 minutes',goal:'High protein',cuisine:'Punjabi'});assert.ok(result.data.recipes.every(r=>r.cuisine==='Punjabi'));assert.ok(result.data.recipes.every(r=>r.protein.label==='Good protein'));
});
test('individual invalid candidates are rejected without losing valid Gemma recipes',async t=>{
 const app=await launch({mock:true});t.after(()=>app.close());const {result}=await addAndGenerate(app,['tomatoes','paneer'],{equipment:['Stovetop'],goal:'partial-candidates'});assert.equal(result.data.provider,'gemma');assert.equal(result.data.receivedCandidates,8);assert.equal(result.data.rejectedCandidates,1);assert.equal(result.data.validCandidates,7);assert.equal(result.data.returnedCandidates,result.data.recipes.length);assert.ok(result.data.recipes.length>=1);assert.equal((app.logs.join('').match(/request_started/g)||[]).length,1);
});
test('noncanonical ingredient sources normalize from selected names before per-recipe validation',async t=>{
 for(const names of [['pyaaj','besan'],['spinach','mushroom']]){
  const app=await launch({mock:true});try{const {result,selected}=await addAndGenerate(app,names,{equipment:['Stovetop'],time:'30 minutes'});assert.equal(result.data.provider,'gemma');assert.equal(result.data.requestedCandidates,8);assert.ok(result.data.recipes.length>0);assert.ok(result.data.recipes.every(recipe=>recipe.ingredients.filter(i=>selected.includes(i.name)).every(i=>i.source==='selected')));assert.ok(result.data.recipes.every(recipe=>recipe.ingredients.every(i=>['selected','kitchen_staple','optional'].includes(i.source))));}finally{await app.close();}
 }
});
test('direct Gemma debug returns raw multi-candidate output and per-candidate validation',async t=>{
 const app=await launch({mock:true});t.after(()=>app.close());const d=await app.call('/api/debug/gemma-recipe','POST',debugPayload([{name:'tomatoes',quantity:3},{name:'paneer',quantity:200}],['Stovetop','Microwave'],'Indian',20));assert.equal(d.status,200);assert.equal(d.data.source,'gemma');assert.equal(d.data.requestedCandidates,8);assert.match(d.data.rawModelResponse,/Quick Paneer Tomato Masala/);assert.equal(d.data.validation.valid,true);assert.ok(d.data.validation.validCount>=6);assert.ok(d.data.normalizedRecipes.every(r=>Number.isFinite(r.mealEfficiencyScore)));assert.ok(app.logs.join('').includes('raw_model_output'));
});
test('only when all Gemma candidates fail does emergency fallback run',async t=>{
 const app=await launch({mock:true});t.after(()=>app.close());const {result}=await addAndGenerate(app,['tomatoes','cheese'],{equipment:['Microwave'],time:'20 minutes',goal:'all-invalid-case'});assert.equal(result.data.provider,'pantry-matcher');assert.match(result.data.fallbackReason,/not in the selected pantry/);assert.equal(result.data.notice,'We couldn’t find a recipe that matched all your current constraints. Try relaxing the equipment, time, or cuisine filters.');assert.equal((app.logs.join('').match(/request_started/g)||[]).length,1);
});
test('provider failure remains an emergency fallback and reports the cause',async t=>{
 const app=await launch({mock:true});t.after(()=>app.close());const {result}=await addAndGenerate(app,['tomatoes','cheese'],{equipment:['Microwave'],goal:'fallback-case'});assert.equal(result.data.provider,'pantry-matcher');assert.match(result.data.fallbackReason,/Gemma HTTP 503/);assert.ok(result.data.recipes[0].steps.some(s=>/microwave/i.test(s)));
});
test('production requires Atlas storage and empty selection is rejected',async t=>{
 await assert.rejects(()=>launch({production:true}),/server exited before readiness/);
 const app=await launch({mock:true});t.after(()=>app.close());const empty=await app.call('/api/recipes/generate','POST',{ingredients:[],time:'30 minutes',equipment:['One pan']});assert.equal(empty.status,400);assert.match(empty.data.error,/Select at least one/);assert.doesNotMatch(app.logs.join(''),/request_started/);
});

test('partial JSON arrays recover each complete recipe object before a truncated tail',async t=>{
 const app=await launch({mock:true});t.after(()=>app.close());
 const payload={...debugPayload([{name:'tomatoes',quantity:2},{name:'paneer',quantity:150}],['Stovetop'],'Indian',30),goal:'quick'};
 const complete=await app.call('/api/debug/gemma-recipe','POST',payload);assert.equal(complete.status,200);assert.equal(complete.data.parsedCandidates.length,8);
 const partial=await app.call('/api/debug/gemma-recipe','POST',{...payload,goal:'truncated-case'});assert.equal(partial.status,200);assert.equal(partial.data.parsedCandidates.length,2);assert.equal(partial.data.validation.validCount,2);
});
test('curd receives a moderate protein label and is not claimed as a strong high-protein match',async t=>{
 const app=await launch({mock:true});t.after(()=>app.close());const {result}=await addAndGenerate(app,['curd'],{equipment:['Stovetop'],time:'No preference',goal:'High protein'});assert.ok(result.data.recipes.every(r=>r.protein.label==='Moderate protein'));assert.ok(result.data.recipes.every(r=>r.goalMatch==='Best available match'));assert.ok(result.data.recipes.every(r=>r.mealRole==='Side / accompaniment'));
});


test('marking a recipe made records history and updates pantry in one request',async t=>{
 const app=await launch({mock:true});const added=await app.call('/api/pantry','POST',{items:[{name:'tomatoes',quantity:2,unit:'pieces'},{name:'paneer',quantity:1,unit:'pack'}]});
 const gen=await app.call('/api/recipes/generate','POST',{ingredients:added.data.items.map(x=>x.id),equipment:['Stovetop'],time:'30 minutes',cuisine:'Indian'});const recipe=gen.data.recipes[0];
 const made=await app.call(`/api/recipes/${recipe.id}/made`,'POST',{useIngredients:true});assert.equal(made.status,201);assert.ok(made.data.item.madeAt);assert.equal((await app.call('/api/recipes/recently-made')).data.items[0].id,recipe.id);
 assert.ok(made.data.pantry.length<2);await app.close({cleanup:false});const restarted=await launch({existingDir:app.dir});t.after(()=>restarted.close());assert.equal((await restarted.call('/api/recipes/recently-made')).data.items.length,1);assert.equal((await restarted.call('/api/pantry')).data.items.length,made.data.pantry.length);
});

test('planner accepts a date first, persists entries, and supports removal',async t=>{
 const app=await launch({mock:true});t.after(()=>app.close());const added=await app.call('/api/pantry','POST',{name:'eggs',quantity:2,unit:'pieces'});const gen=await app.call('/api/recipes/generate','POST',{ingredients:[added.data.items[0].id],equipment:['Stovetop']});const recipe=gen.data.recipes[0];
 const planned=await app.call('/api/meal-plan','POST',{recipeId:recipe.id,day:'2026-10-05'});assert.equal(planned.status,201);assert.equal(planned.data.items[0].day,'2026-10-05');assert.equal((await app.call('/api/meal-plan')).data.items.length,1);assert.equal((await app.call(`/api/meal-plan/${planned.data.items[0].id}`,'DELETE')).status,200);assert.equal((await app.call('/api/meal-plan')).data.items.length,0);
});

test('broad cuisine preferences and reminder choices persist',async t=>{
 const app=await launch();t.after(()=>app.close());const saved=await app.call('/api/preferences','PATCH',{cuisines:['Indian','Global / International'],indianCuisines:['Punjabi'],reminders:{inAppFreshness:false,email:false,push:false}});assert.deepEqual(saved.data.cuisines,['Indian','Global / International']);assert.deepEqual(saved.data.indianCuisines,['Punjabi']);assert.equal(saved.data.reminders.inAppFreshness,false);assert.equal((await app.call('/api/preferences')).data.indianCuisines[0],'Punjabi');
});

test('explicit past expiry dates produce an actionable check state and notes persist',async t=>{
 const app=await launch();t.after(()=>app.close());const added=await app.call('/api/pantry','POST',{name:'tomatoes',quantity:4,unit:'pieces',purchaseDate:'2026-10-02',expiryDate:'2026-10-03',notes:'Use for Sunday lunch'});assert.equal(added.data.items[0].freshnessStatus,'expired');
 const id=added.data.items[0].id,edited=await app.call(`/api/pantry/${id}`,'PATCH',{name:'tomatoes',quantity:4,unit:'pieces',category:'Vegetables',purchaseDate:'2026-10-02',expiryDate:'2026-10-03',notes:'Use for breakfast'});assert.equal(edited.data.item.notes,'Use for breakfast');assert.equal((await app.call('/api/pantry')).data.items[0].freshnessStatus,'expired');
 assert.equal((await app.call(`/api/pantry/${id}`,'DELETE')).status,200);assert.equal((await app.call('/api/pantry')).data.items.length,0);
});
