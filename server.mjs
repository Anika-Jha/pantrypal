import 'dotenv/config';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openStore } from './storage.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const dataDir = path.join(root, 'data');
const dataFile = process.env.PANTRYPAL_DATA_FILE || path.join(dataDir, 'pantrypal.json');
const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.svg':'image/svg+xml' };
let repository, mongoStatus = 'local-json';
const KITCHEN_PROFILE_STAPLES={
  Indian:['salt','water','cooking oil','turmeric','red chilli powder','cumin seeds','coriander powder','garam masala','mustard seeds','hing','black pepper','ginger','garlic'],
  Western:['salt','olive oil','black pepper','garlic','butter','lemon juice'],
  Minimal:['salt','water','cooking oil'],
  Custom:[]
};
const defaultKitchenStaples=()=>KITCHEN_PROFILE_STAPLES.Indian.map(name=>({name,enabled:true,custom:false}));
let state = { pantry: [], recipes: [], recipeHistory: [], feedback: [], preferences: { goals:['High protein'], cuisines:[], indianCuisines:[], equipment:['One pan'], time:'20 minutes', effort:'Easy',kitchenProfile:'Indian',kitchenStaples:defaultKitchenStaples(),reminders:{inAppFreshness:true,email:false,push:false} }, mealPlan: [] };
async function initStore() {
  repository = await openStore({ defaults: state, dataFile, env: process.env });
  state = repository.state;
  mongoStatus = repository.mode;
  normalizeState();
}
async function persist() { await repository.save(state); }
const json = (res, status, body) => { res.writeHead(status, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }); res.end(JSON.stringify(body)); };
class HttpError extends Error { constructor(status, message) { super(message); this.status=status; } }
async function body(req) {
  let raw=''; for await (const chunk of req) { raw += chunk; if (raw.length > 100_000) throw new HttpError(413,'Request is too large.'); }
  if (!raw) return {}; try { return JSON.parse(raw); } catch { throw new HttpError(400,'Send valid JSON.'); }
}
const text = (v, max=160) => typeof v === 'string' ? v.trim().slice(0,max) : '';
const norm = v => text(v,80).toLowerCase().replace(/[^\p{L}\p{N} ]/gu,'').trim();
const categories = ['Dairy','Vegetables','Fruits','Grains','Protein','Pantry staples','Frozen','Other'];
const validId = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value||'');
function optionalDate(value, label) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpError(400, `${label} must be a valid YYYY-MM-DD date.`);
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0,10) !== value) throw new HttpError(400, `${label} must be a real calendar date.`);
  return value;
}
function freshness(item) {
  if (!item.expiryDate) return 'unknown';
  const now = new Date(), today = Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate());
  const days = Math.round((Date.parse(`${item.expiryDate}T00:00:00.000Z`) - today) / 86400000);
  if (days < 0) return 'expired'; if (days <= 2) return 'use-first'; if (days <= 5) return 'use-soon'; return 'fresh';
}
function pantryItem(input) {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new HttpError(400,'Ingredient data must be an object.');
  const name=text(input.name,80); if (!name) throw new HttpError(400,'Ingredient name is required.');
  if(typeof input.name==='string'&&input.name.trim().length>80)throw new HttpError(400,'Ingredient name must be 80 characters or fewer.');
  const qty=input.quantity === '' || input.quantity == null ? null : Number(input.quantity);
  if (qty !== null && (!Number.isFinite(qty) || qty < 0)) throw new HttpError(400,'Quantity must be zero or greater.');
  if(input.unit!=null&&typeof input.unit!=='string')throw new HttpError(400,'Unit must be text.');
  if(typeof input.unit==='string'&&input.unit.trim().length>30)throw new HttpError(400,'Unit must be 30 characters or fewer.');
  const category=input.category==null||input.category===''?guessCategory(name):input.category;
  if(!categories.includes(category))throw new HttpError(400,'Choose a valid pantry category.');
  const expiryDate=optionalDate(input.expiryDate ?? input.explicitExpiryDate,'Expiry date');
  const purchaseDate=optionalDate(input.purchaseDate,'Purchase date');
  const createdAt=input.createdAt||new Date().toISOString();
  const item={ id:input.id || randomUUID(), name, normalizedName:norm(name), quantity:qty, unit:text(input.unit,30), category, purchaseDate,
    expiryDate, notes:text(input.notes,240), createdAt, updatedAt:new Date().toISOString() };
  item.freshnessStatus=freshness(item); return item;
}
function normalizeState() {
  state.pantry=Array.isArray(state.pantry)?state.pantry.map(old=>{
    let purchaseDate='',expiryDate='';try{purchaseDate=optionalDate(old.purchaseDate,'Purchase date')}catch{}try{expiryDate=optionalDate(old.expiryDate||old.explicitExpiryDate,'Expiry date')}catch{}
    const item={...old,id:validId(old.id)?old.id:randomUUID(),purchaseDate,expiryDate,notes:old.notes||'',createdAt:old.createdAt||old.updatedAt||new Date().toISOString()};
    if(!categories.includes(item.category))item.category=guessCategory(item.name||'');
    item.freshnessStatus=freshness(item); return item;
  }):[];
  state.recipes=Array.isArray(state.recipes)?state.recipes.map(r=>{const minutes=Number(r.timeMinutes??r.cookMinutes)||20,ingredients=Array.isArray(r.ingredients)?r.ingredients:[],steps=Array.isArray(r.steps)?r.steps:[],efficiency=r.efficiency||{},scoreBreakdown=r.scoreBreakdown||{wasteSaved:Number(efficiency.wasteSaved)||0,timeEfficiency:Number(efficiency.timeEfficiency)||0,ingredientCoverage:Number(efficiency.coverage)||0};const createdAt=r.createdAt||new Date().toISOString();return {...r,createdAt,updatedAt:r.updatedAt||createdAt,timeMinutes:minutes,cookMinutes:minutes,timeBucket:r.timeBucket||timeBucket(minutes),effort:r.effort||deriveEffort({steps}),equipment:recipeEquipmentLabels(r.equipment,steps),protein:typeof r.protein==='object'&&r.protein?.label?r.protein:deriveProtein(ingredients,Number(r.servings)||1),proteinFlag:r.proteinFlag||r.protein?.label||deriveProtein(ingredients,Number(r.servings)||1).label,pantryMatch:Number.isFinite(Number(r.pantryMatch??r.kitchenMatch??r.matchScore))?Number(r.pantryMatch??r.kitchenMatch??r.matchScore):0,kitchenMatch:Number.isFinite(Number(r.kitchenMatch??r.pantryMatch))?Number(r.kitchenMatch??r.pantryMatch):0,matchScore:Number.isFinite(Number(r.matchScore??r.pantryMatch))?Number(r.matchScore??r.pantryMatch):0,mealEfficiencyScore:Number.isFinite(Number(r.mealEfficiencyScore??efficiency.score))?Number(r.mealEfficiencyScore??efficiency.score):0,scoreBreakdown,efficiency:{...efficiency,score:Number(efficiency.score??r.mealEfficiencyScore)||0}}}):[];
  state.feedback=Array.isArray(state.feedback)?state.feedback:[];
  state.recipeHistory=Array.isArray(state.recipeHistory)?state.recipeHistory:[];
  state.preferences=state.preferences&&typeof state.preferences==='object'?state.preferences:{goals:['High protein'],cuisines:[],equipment:['One pan'],time:'20 minutes',effort:'Easy'};
  state.preferences.kitchenProfile=Object.hasOwn(KITCHEN_PROFILE_STAPLES,state.preferences.kitchenProfile)?state.preferences.kitchenProfile:'Indian';
  state.preferences.cuisines=Array.isArray(state.preferences.cuisines)?state.preferences.cuisines:[];
  state.preferences.cuisines=state.preferences.cuisines.map(value=>value==='International'?'Global / International':value);
  state.preferences.indianCuisines=Array.isArray(state.preferences.indianCuisines)?state.preferences.indianCuisines:[];
  const legacyRegions=['North Indian','South Indian','Bengali','Bihari','Punjabi','Gujarati','Maharashtrian','Other Indian'];
  const oldRegions=state.preferences.cuisines.filter(value=>legacyRegions.includes(value));
  if(oldRegions.length){state.preferences.cuisines=[...new Set([...state.preferences.cuisines.filter(value=>!legacyRegions.includes(value)),'Indian'])];state.preferences.indianCuisines=[...new Set([...state.preferences.indianCuisines,...oldRegions])];}
  state.preferences.reminders={inAppFreshness:true,email:false,push:false,...(state.preferences.reminders||{})};
  const existingStaples=Array.isArray(state.preferences.kitchenStaples)?state.preferences.kitchenStaples:null;
  state.preferences.kitchenStaples=existingStaples?existingStaples.map(item=>typeof item==='string'?{name:text(item,60),enabled:true,custom:false}:{name:text(item?.name,60),enabled:item?.enabled!==false,custom:Boolean(item?.custom)}).filter(item=>item.name).slice(0,60):defaultKitchenStaples();
  state.mealPlan=Array.isArray(state.mealPlan)?state.mealPlan:[];
  state.mealPlan=state.mealPlan.map(entry=>({...entry,day:entry.day||entry.date||new Date().toISOString().slice(0,10)}));
}
const knownUnits = new Set(['g','kg','ml','l','cup','cups','packet','packets','piece','pieces','pcs','bunch','bunches','can','cans','bag','bags','bottle','bottles']);
function parseIngredients(input) {
  const source=text(input,1200).replace(/^(?:i\s+)?(?:just\s+)?(?:bought|got|picked\s+up|have)\s+/i,''); if (!source) throw new HttpError(400,'Tell me what you brought home first.');
  return source.split(/[,\n;]+|\band\b/gi).map(part=>part.trim()).filter(Boolean).map(part=>{
    const match=part.match(/^(?:some\s+)?(?:(\d+(?:\.\d+)?)\s+)?(?:(g|kg|ml|l|cups?|packets?|pieces?|pcs|bunches?|cans?|bags?|bottles?)\s+(?:of\s+)?|(?:some\s+))?(.+?)$/i);
    if (!match) return {name:part,quantity:null,unit:'',category:guessCategory(part)};
    let name=match[3].replace(/^(?:some|a little|a few|of)\s+/i,'').trim();
    if (name.split(/\s+/).length > 5 || knownUnits.has(name.toLowerCase())) name=part;
    return { name, quantity:match[1] ? Number(match[1]) : null, unit:match[2] || '', category:guessCategory(name) };
  }).filter(x=>x.name);
}
function guessCategory(name) {
  const n=norm(name);
  if (/milk|paneer|cheese|yogurt|curd|butter|cream/.test(n)) return 'Dairy';
  if (/spinach|tomato|onion|potato|pepper|carrot|broccoli|garlic|ginger|cucumber|lettuce|peas/.test(n)) return 'Vegetables';
  if (/apple|banana|orange|mango|berry|lemon|lime/.test(n)) return 'Fruits';
  if (/rice|flour|oats|pasta|bread|noodle/.test(n)) return 'Grains';
  if (/egg|chicken|tofu|chickpea|lentil|bean|fish|meat/.test(n)) return 'Protein';
  return 'Other';
}
const RECIPE_MODEL='gemma-4-26b-a4b-it';
function extractJsonValue(raw) {
  const source=String(raw||'').replace(/```(?:json)?/gi,'');
  try{return JSON.parse(source.trim())}catch{}
  const arrayStart=source.indexOf('[');
  if(arrayStart>=0){
    const recovered=[];let i=arrayStart+1;
    while(i<source.length){while(/[\s,]/.test(source[i]||' '))i++;if(source[i]===']')break;if(source[i]!=='{')break;const start=i,stack=[];let inString=false,escaped=false;
      for(;i<source.length;i++){const ch=source[i];if(inString){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')inString=false;continue;}if(ch==='"'){inString=true;continue;}if(ch==='{'||ch==='[')stack.push(ch);else if(ch==='}'||ch===']'){const open=stack.pop();if((open==='{'&&ch!=='}')||(open==='['&&ch!==']'))break;if(!stack.length){try{const value=JSON.parse(source.slice(start,i+1));if(value&&typeof value==='object'&&!Array.isArray(value))recovered.push(value);}catch{}i++;break;}}}
      if(i>=source.length)break;
    }
    if(recovered.length)return recovered;
  }
  for(let start=0;start<source.length;start++){
    if(source[start]!=='{'&&source[start]!=='[')continue;
    const stack=[];let inString=false,escaped=false;
    for(let i=start;i<source.length;i++){
      const ch=source[i];
      if(inString){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')inString=false;continue;}
      if(ch==='"'){inString=true;continue;}
      if(ch==='{'||ch==='[')stack.push(ch);
      else if(ch==='}'||ch===']'){
        const open=stack.pop();if((open==='{'&&ch!=='}')||(open==='['&&ch!==']'))break;
        if(!stack.length){try{return JSON.parse(source.slice(start,i+1))}catch{break}}
      }
    }
  }
  throw new Error('Could not extract valid JSON candidates from Gemma response.');
}
function extractJsonObject(raw) { const value=extractJsonValue(raw);if(value&&typeof value==='object'&&!Array.isArray(value))return value;throw new Error('Gemma JSON response was not an object.'); }
const CUISINES=['Indian','North Indian','South Indian','Bengali','Bihari','Punjabi','Gujarati','Maharashtrian','International','Any'];
const TIME_BUCKETS=[10,20,30,45,60];
function parseTimeLimit(value){if(value===null||value===undefined||value===''||/no\s*preference/i.test(String(value))||Number(value)===120)return null;const n=Number(String(value).match(/\d+/)?.[0]);return Number.isFinite(n)&&n>0?Math.min(180,n):20;}
function timeBucket(minutes){return TIME_BUCKETS.find(limit=>minutes<=limit)?`${TIME_BUCKETS.find(limit=>minutes<=limit)} minutes`:'No preference';}
function canonicalCuisine(value, requested='Any'){
  if(requested&&requested!=='Any')return requested;
  const s=text(value,50).toLowerCase();return CUISINES.find(x=>x.toLowerCase()===s)||'International';
}
function equipmentOptions(value){const values=(Array.isArray(value)?value:[value]).map(x=>text(x,60)).filter(Boolean);return values.length?values:['No preference'];}
function equipmentMode(value) {
  const e=text(value,80).toLowerCase().replace(/[_-]+/g,' ').replace(/\s+/g,' ').trim();
  if(/no cook|uncooked|no heat/.test(e))return 'no-cook';if(/microwave/.test(e))return 'microwave';if(/air fryer/.test(e))return 'air-fryer';if(/pressure cooker/.test(e))return 'pressure-cooker';if(/oven/.test(e))return 'oven';if(/one pan/.test(e))return 'one-pan';if(/one pot/.test(e))return 'one-pot';if(/multiple pans|multiple pots|multiple vessels/.test(e))return 'multiple';if(/stovetop|cooktop|skillet|frying pan|\bpan\b|\bpot\b/.test(e))return 'stovetop';return 'other';
}
function equipmentLabel(value){const e=equipmentMode(value);return ({'no-cook':'No-cook','microwave':'Microwave','air-fryer':'Air fryer','pressure-cooker':'Pressure cooker','oven':'Oven','one-pan':'One pan','one-pot':'One pot','stovetop':'Stovetop','multiple':'Multiple pans/pots'})[e]||null;}
function recipeEquipmentLabels(value,steps=[]){
  const items=Array.isArray(value)?value:[value],labels=[...new Set(items.map(equipmentLabel).filter(Boolean))];
  for(const preferred of ['One pan','One pot','Pressure cooker','Microwave','Air fryer','Oven','No-cook','Stovetop'])if(labels.includes(preferred))return [preferred];
  const words=steps.join(' ').toLowerCase();if(/microwave/.test(words))return ['Microwave'];if(/air fryer|air fry/.test(words))return ['Air fryer'];if(/oven|bake|roast/.test(words))return ['Oven'];if(/pressure cooker/.test(words))return ['Pressure cooker'];if(/\b(?:pan|skillet|stovetop|sauté|saute|fry|pot|simmer)\b/.test(words))return ['Stovetop'];return labels.length?labels:['No-cook'];
}
function normalizeRecipeCandidate(input) {
  if(!input||typeof input!=='object'||Array.isArray(input))return {recipe:null,reason:'recipe must be an object'};
  const steps=Array.isArray(input.steps)?input.steps:[],equipment=recipeEquipmentLabels(input.equipment,steps);
  return {recipe:{...input,equipment,timeMinutes:input.timeMinutes??input.cookMinutes},reason:null};
}
function comparableIngredientName(value) {
  return norm(value).split(' ').filter(word=>!['chopped','diced','sliced','grated','shredded','crumbled','fresh','raw','cooked','frozen'].includes(word)).map(word=>word.endsWith('oes')?word.slice(0,-2):word.length>4&&word.endsWith('ies')?`${word.slice(0,-3)}y`:word.length>3&&word.endsWith('s')&&!word.endsWith('ss')?word.slice(0,-1):word).join(' ');
}
function equipmentUseFailure(recipe, selectedEquipment) {
  const available=equipmentOptions(selectedEquipment).map(equipmentMode),labels=recipeEquipmentLabels(recipe.equipment,recipe.steps);
  if(available.includes('other')||available.includes('multiple'))return null;
  const selectedModes=new Set(available),chosen=labels[0],chosenMode=equipmentMode(chosen),steps=recipe.steps.join(' ').toLowerCase();
  if(chosenMode==='other')return 'recipe equipment could not be identified';
  const compatible=(mode)=>{
    if(selectedModes.has(mode))return true;
    if(mode==='stovetop')return selectedModes.has('one-pan')||selectedModes.has('one-pot');
    if(mode==='one-pan')return selectedModes.has('stovetop')||selectedModes.has('one-pan');
    if(mode==='one-pot')return selectedModes.has('stovetop')||selectedModes.has('one-pot');
    return false;
  };
  if(!compatible(chosenMode))return `recipe requires ${chosen}, which is not among the available equipment`;
  if(chosenMode==='microwave'&&!/microwav/.test(steps))return 'recipe is labelled microwave but its steps do not use a microwave';
  if(chosenMode==='microwave'&&/\b(?:stovetop|cooktop|skillet|frying pan|pan|oven|air fryer|sauté|saute)\b/.test(steps))return 'microwave recipe steps require unavailable cooking equipment';
  if(chosenMode==='air-fryer'&&!/air fry|air fryer/.test(steps))return 'air fryer was selected but the steps do not use it';
  if(chosenMode==='oven'&&(!/oven/.test(steps)||!/(?:bake|roast|broil)/.test(steps)))return 'oven was selected but the steps do not cook in an oven';
  if(chosenMode==='no-cook'&&/\b(?:cook|heat|boil|simmer|fry|sauté|saute|bake|roast|broil|microwave|air fry|toast|warm)\b/.test(steps))return 'no-cook recipe contains cooking or heating steps';
  const strictOnePan=chosenMode==='one-pan'||(selectedModes.size===1&&selectedModes.has('one-pan'));
  if(strictOnePan){
    const forbidden=/\b(?:bowl|pot|saucepan|strainer|colander|second pan|another pan|another pot|separate pot|separate pan|mixing bowl|oven|air fryer|microwave|blender|food processor)\b|boil .* separately|transfer .* to .* (?:vessel|bowl|pot|pan|dish)/i;
    if(!/\b(?:skillet|frying pan|pan)\b/.test(steps))return 'one-pan recipe does not cook in its selected pan';
    const bad=recipe.steps.find(step=>forbidden.test(step));if(bad)return `one-pan step requires another vessel/equipment: ${bad}`;
  }
  if(chosenMode==='one-pot'){
    if(!/\bpot\b/.test(steps)||/\b(?:skillet|frying pan|another pot|separate pot)\b/.test(steps))return 'one-pot recipe requires another vessel or does not use its pot';
  }
  if(chosenMode==='pressure-cooker'&&!/pressure cooker/.test(steps))return 'pressure cooker was selected but the steps do not use it';
  if(chosenMode==='stovetop'&&!/\b(?:stovetop|cooktop|skillet|frying pan|pan|pot|heat|cook|sauté|saute|fry|simmer|boil)\b/.test(steps))return 'stovetop recipe steps do not describe a cooking action';
  if(chosenMode==='stovetop'&&/\b(?:microwave|oven|air fryer|air fry)\b/.test(steps))return 'stovetop recipe steps use a different appliance';
  return null;
}
function ingredientMentioned(name,steps){
  const value=norm(name),textValue=steps.join(' ').toLowerCase();if(textValue.includes(value))return true;
  const aliases={'cooking oil':['oil','olive oil','vegetable oil'],'olive oil':['oil'],'cumin seeds':['cumin'],'mustard seeds':['mustard'],'coriander powder':['coriander'],'red chilli powder':['chilli powder','chili powder','chilli','chili'],'black pepper':['pepper'],'hing':['asafoetida']};
  return (aliases[value]||[]).some(alias=>new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\b`,'i').test(textValue));
}
function deriveProtein(ingredients, servings=1){
  const items=ingredients.filter(i=>/paneer|tofu|soy|egg|chickpea|lentil|bean|pea|chicken|fish|meat|curd|yogurt|cheese/i.test(i.name));
  const names=items.map(i=>i.name.toLowerCase()),distinct=new Set(names.map(n=>/paneer|cheese|curd|yogurt/.test(n)?'dairy':/egg/.test(n)?'egg':/tofu|soy/.test(n)?'soy':/chickpea|lentil|bean|pea/.test(n)?'legume':'meat'));
  const substantial=items.filter(i=>{const amount=Number(String(i.amount||'').match(/[\d.]+/)?.[0]);const unit=String(i.amount||'').toLowerCase();if(/egg/.test(i.name.toLowerCase()))return amount>=2;if(/paneer|tofu|chicken|fish|meat|cheese/.test(i.name.toLowerCase()))return /g|gram/.test(unit)&&amount>=100||amount>=1&&/cup/.test(unit);if(/curd|yogurt/.test(i.name.toLowerCase()))return amount>=400&&/g|gram/.test(unit);return amount>=150&&/g|gram/.test(unit)||amount>=1&&/cup|can/.test(unit)});
  const strong=items.length>0;
  let label='Light protein';if(strong)label='Moderate protein';if(substantial.length)label='Good protein';if(substantial.length>=2||distinct.size>=2&&substantial.length)label='High protein';
  return {label,gramsEstimate:null,deterministic:true};
}
function deriveEffort(recipe){const steps=recipe.steps||[],joined=steps.join(' ').toLowerCase(),techniques=(joined.match(/\b(?:sauté|saute|simmer|roast|bake|whisk|fold|temper|knead|marinate|reduce|fry|boil|blend)\b/g)||[]).length;if(steps.length<=3&&techniques<=2)return 'Very easy';if(steps.length<=5&&techniques<=4)return 'Easy';if(steps.length<=7&&techniques<=7)return 'Medium';return 'Challenge';}
function goalRelevance(recipe, goal){const g=norm(goal),p=recipe.protein?.label||'Light protein';if(/high protein/.test(g)){return ({'High protein':100,'Good protein':82,'Moderate protein':38,'Light protein':0})[p]??0;}if(/quick/.test(g))return Math.max(0,100-recipe.timeMinutes*3);if(/healthy/.test(g))return /vegetable|spinach|tomato|broccoli|pea|bean/i.test(recipe.ingredients.map(i=>i.name).join(' '))?70:45;if(/comfort/.test(g))return 60;if(/reduce waste/.test(g))return recipe.efficiency?.wasteSaved??0;return 50;}
function validateRecipe(input, selectedItems, goal='', equipmentChoice='', maxTime=180, kitchenStaples=[], cuisineChoice='Any') {
  const fail=reason=>({recipe:null,reason});
  const normalized=normalizeRecipeCandidate(input);if(!normalized.recipe)return fail(normalized.reason);const r=normalized.recipe;
  if(typeof r.title!=='string'||!r.title.trim())return fail('title is missing or not a non-empty string');
  if(!Array.isArray(r.ingredients)||!r.ingredients.length)return fail('ingredients must be a non-empty array');
  if(!Array.isArray(r.steps)||!r.steps.length||r.steps.some(s=>typeof s!=='string'||!s.trim()))return fail('steps must be a non-empty array of non-empty strings');
  if(!Number.isInteger(Number(r.timeMinutes))||Number(r.timeMinutes)<=0)return fail('timeMinutes must be a positive integer');
  if(Number.isFinite(maxTime)&&Number(r.timeMinutes)>maxTime)return fail(`timeMinutes ${r.timeMinutes} exceeds selected limit ${maxTime}`);
  if(r.servings!==undefined&&(!Number.isFinite(Number(r.servings))||Number(r.servings)<=0))return fail('servings must be a positive number when provided');
  const available=selectedItems.map(item=>({name:item.name,key:comparableIngredientName(item.name),item}));
  const staples=(Array.isArray(kitchenStaples)?kitchenStaples:[]).filter(i=>i&&i.enabled!==false&&text(i.name||i,60)).map(i=>({name:text(i.name||i,60),key:comparableIngredientName(i.name||i)}));
  const ingredients=[];
  for(let index=0;index<r.ingredients.length;index++){
    const raw=r.ingredients[index];if(!raw||typeof raw!=='object'||Array.isArray(raw))return fail(`ingredients[${index}] must be an object`);
    const name=text(raw.name,100);if(!name)return fail(`ingredients[${index}].name is missing`);
    const amount=raw.amount??raw.quantity;if(amount===undefined||amount===null||!['string','number'].includes(typeof amount))return fail(`ingredients[${index}].amount is missing or invalid`);
    const key=comparableIngredientName(name),match=available.find(i=>i.key===key),staple=staples.find(i=>i.key===key);let source=raw.source||(match?'selected':staple?'kitchen_staple':null);
    if(!['selected','kitchen_staple','optional'].includes(source))return fail(`ingredients[${index}].source must be selected, kitchen_staple, or optional`);
    if(source==='selected'&&!match)return fail(`ingredient "${name}" is not in the selected pantry`);if(source==='kitchen_staple'&&!staple)return fail(`ingredient "${name}" is not an enabled kitchen staple`);if(source==='optional'&&!match&&!staple)return fail(`optional ingredient "${name}" is not available in selected pantry or kitchen staples`);
    const canonical=match?.name||staple?.name||name,quantity=String(amount);ingredients.push({name:canonical,amount:quantity,quantity,source,...(source==='kitchen_staple'?{pantryBasic:true}:{})});
  }
  const used=[...new Set(ingredients.filter(i=>i.source==='selected').map(i=>i.name))];if(!used.length)return fail('recipe must use at least one selected pantry ingredient');
  const steps=r.steps.map(s=>text(s,400)).filter(Boolean).slice(0,12),stepText=steps.join(' ').toLowerCase();
  const commonFoods=['bread','onion','garlic','butter','flour','milk','rice','pasta','egg','paneer','tofu','chicken','lentil','beans','cheese'];
  for(const food of commonFoods)if(new RegExp(`\\b${food}\\b`,'i').test(stepText)&&!available.some(i=>i.key.split(' ').includes(food))&&!staples.some(i=>i.key.split(' ').includes(food)))return fail(`steps mention unavailable ingredient "${food}"`);
  const equipment=recipeEquipmentLabels(r.equipment,steps);if(!equipment.length)return fail('equipment/method is missing');
  const equipmentFailure=equipmentUseFailure({...r,steps,equipment},equipmentChoice);if(equipmentFailure)return fail(equipmentFailure);
  for(const ingredient of ingredients.filter(i=>i.source==='kitchen_staple'))if(!ingredientMentioned(ingredient.name,steps))return fail(`kitchen staple "${ingredient.name}" is listed but not used in recipe steps`);
  const minutes=Math.round(Number(r.timeMinutes)),expiring=selectedItems.filter(i=>['use-first','use-soon'].includes(i.freshnessStatus));
  const wasteSaved=expiring.length?Math.round(used.filter(n=>expiring.some(i=>norm(i.name)===norm(n))).length/expiring.length*100):0;
  const scoreTimeLimit=Number.isFinite(maxTime)?maxTime:60,timeEfficiency=Math.round(Math.max(0,Math.min(100,(1-minutes/scoreTimeLimit)*100))),coverage=Math.round(used.length/Math.max(1,selectedItems.length)*100),score=Math.round(wasteSaved*.4+timeEfficiency*.3+coverage*.3);
  const scoreBreakdown={wasteSaved,timeEfficiency,ingredientCoverage:coverage},protein=deriveProtein(ingredients,Number(r.servings)||1);
  const recipe={id:randomUUID(),title:text(r.title,90),description:text(r.description,240)||'Made around the ingredients you selected.',cuisine:canonicalCuisine(r.cuisine,cuisineChoice),style:text(r.style,50),effort:deriveEffort({...r,steps}),timeMinutes:minutes,timeBucket:timeBucket(minutes),cookMinutes:minutes,servings:Math.max(1,Math.min(12,Number(r.servings)||1)),equipment,onePan:equipment.includes('One pan'),ingredients,steps,substitutions:Array.isArray(r.substitutions)?r.substitutions.map(x=>text(x,180)).filter(Boolean).slice(0,8):[],tips:Array.isArray(r.tips)?r.tips.map(x=>text(x,180)).filter(Boolean).slice(0,8):[],pantryUsed:used,pantryMatch:coverage,kitchenMatch:coverage,matchScore:coverage,scoreBreakdown,mealEfficiencyScore:score,efficiency:{wasteSaved,timeEfficiency,coverage,score},protein,proteinFlag:protein.label,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),saved:false,generatedBy:'gemma'};
  const selectedNames=ingredients.filter(i=>i.source==='selected').map(i=>i.name.toLowerCase());
  recipe.mealRole=/pancake mix|batter mix/.test(selectedNames.join(' '))?'Breakfast / snack':selectedNames.length===1&&/curd|yogurt/.test(selectedNames[0])?'Side / accompaniment':['Light protein','Moderate protein'].includes(protein.label)&&!ingredients.some(i=>/rice|pasta|bread|oat|grain|potato/i.test(i.name))?'Side / light meal':'Meal';
  recipe.goalRelevance=goalRelevance(recipe,goal);recipe.goalMatch=/high protein/i.test(goal)&&recipe.goalRelevance<75?'Best available match':recipe.goalRelevance>=75?'Strong match':'Good match';
  return {recipe,reason:null};
}
function recipeCandidates(data){if(Array.isArray(data))return data;if(Array.isArray(data?.recipes))return data.recipes;if(data&&typeof data==='object'&&data.title)return [data];return [];}
function normalizeIngredientSources(candidate,selectedItems,kitchenStaples){
  if(!candidate||typeof candidate!=='object'||!Array.isArray(candidate.ingredients))return candidate;
  const selected=new Set(selectedItems.map(i=>comparableIngredientName(i.name)));
  const staples=new Set((Array.isArray(kitchenStaples)?kitchenStaples:[]).filter(i=>i&&i.enabled!==false).map(i=>comparableIngredientName(i.name||i)));
  return {...candidate,ingredients:candidate.ingredients.map(ingredient=>{
    if(!ingredient||typeof ingredient!=='object'||Array.isArray(ingredient))return ingredient;
    const key=comparableIngredientName(ingredient.name);
    if(selected.has(key))return {...ingredient,source:'selected'};
    if(staples.has(key))return {...ingredient,source:'kitchen_staple'};
    if(typeof ingredient.source==='string'&&ingredient.source.trim().toLowerCase()==='optional')return {...ingredient,source:'optional'};
    return ingredient;
  })};
}
function recipeDiversityKey(recipe){
  const title=recipe.title.toLowerCase(),textValue=`${title} ${recipe.description} ${recipe.steps.join(' ')}`.toLowerCase(),equipment=recipe.equipment.join(','),used=recipe.ingredients.filter(i=>i.source==='selected').map(i=>comparableIngredientName(i.name)).sort().join('+');
  const families=[['mug-cake',/mug cake|soufflé|souffle/],['omelette',/omelette|omelet|scramble|bhurji/],['tempering',/tempering|tempered|tadka/],['dip-raita',/\bdip\b|raita|yogurt bowl|curd bowl/],['pancake',/pancake|crepe/],['curry',/\bcurry\b|kadhi|masala/],['melt',/\bmelt\b/],['salad',/\bsalad\b/],['soup',/\bsoup\b/],['bites',/\bbites?\b|fritter|pakora/],['mash-puree',/\bmash\b|\bpuree\b/],['tikka',/tikka|kebab/],['roast-bake',/roast|\bbake\b/],['toast',/\btoast/],['stuffed',/stuffed|\bwrap\b/]];
  let family=families.find(([,pattern])=>pattern.test(title))?.[0];
  if(!family&&/curd|yogurt/.test(used))family=/temper|tadka/.test(textValue)?'tempering':'curd-preparation';
  if(!family)family=/sauté|saute|stir.?fry/.test(textValue)?'saute':/steam/.test(textValue)?'steam':/simmer|boil/.test(textValue)?'simmer':/microwave/.test(textValue)?'microwave-preparation':'other';
  return `${used}|${equipment}|${family}`;
}
function rankAndDedupe(recipes,goal,count){
  const sorted=[...recipes].sort((a,b)=>(b.goalRelevance-a.goalRelevance)||(b.pantryMatch-a.pantryMatch)||(b.mealEfficiencyScore-a.mealEfficiencyScore)||a.timeMinutes-b.timeMinutes);
  const kept=[],keys=new Set();let duplicateCount=0;for(const recipe of sorted){const key=recipeDiversityKey(recipe);if(keys.has(key)){duplicateCount++;continue;}keys.add(key);kept.push(recipe);if(kept.length>=count)break;}return {recipes:kept,duplicateCount};
}
function validateCandidateSet(data,selectedItems,goal,equipment,maxTime,kitchenStaples,cuisine,count,log){
  const candidates=recipeCandidates(data),valid=[],rejected=[];
  candidates.slice(0,8).forEach((candidate,index)=>{const normalized=normalizeIngredientSources(candidate,selectedItems,kitchenStaples),checked=validateRecipe(normalized,selectedItems,goal,equipment,maxTime,kitchenStaples,cuisine);if(checked.recipe)valid.push(checked.recipe);else{const reason=checked.reason||'invalid recipe';rejected.push({index,reason});log?.('recipe_validation_failed',{index,reason});}});
  const ranked=rankAndDedupe(valid,goal,count);return {candidates,valid,rejected,ranked:ranked.recipes,duplicateCount:ranked.duplicateCount};
}
async function gemma(prompt, log=()=>{}, attempt=1, devDiagnostics=false) {
  const key=process.env.GOOGLE_AI_API_KEY;if(!key)return null;
  const model=RECIPE_MODEL;log('request_started',{model,attempt});
  // Google's structured-output model list does not include Gemma. Keep Gemma selected and
  // request JSON MIME only; app-side parsing and semantic validation enforce the recipe shape.
  const resp=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,{method:'POST',headers:{'content-type':'application/json','x-goog-api-key':key},body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{temperature:0.2,maxOutputTokens:8192,responseMimeType:'application/json',thinkingConfig:{thinkingLevel:'minimal'}}}),signal:AbortSignal.timeout(120000)});
  log('http_response',{model,attempt,status:resp.status});if(!resp.ok){let detail='';try{const err=await resp.json();detail=text(err.error?.message,400).replaceAll(key,'[redacted]')}catch{}log('http_error_detail',{model,status:resp.status,detail:detail||'No provider error message'});throw new Error(`Gemma HTTP ${resp.status}${detail?`: ${detail}`:''}`)}
  let data;try{data=await resp.json()}catch(e){log('response_parse_failed',{model,error:e.message});throw new Error(`Gemma response body was not JSON: ${e.message}`)}
  const raw=data.candidates?.[0]?.content?.parts?.filter(part=>!part.thought)?.map(part=>part.text||'').join('');
  if(!raw){log('response_parse_failed',{model,error:'no non-thought text parts'});throw new Error('Gemma returned no non-thought text parts.');}
  if(devDiagnostics)log('raw_model_output',{model,attempt,output:raw.slice(0,60000)});
  let parsed;try{parsed=extractJsonValue(raw);log('response_parse_succeeded',{model,candidateCount:Array.isArray(parsed)?parsed.length:Array.isArray(parsed?.recipes)?parsed.recipes.length:1});}catch(e){log('response_parse_failed',{model,error:e.message});throw e;}
  return parsed;
}
function isLocalDevelopmentRequest(req) {
  const address=req.socket?.remoteAddress||'';
  return process.env.NODE_ENV!=='production'&&(/^(127\.0\.0\.1|::1|::ffff:127\.)/.test(address));
}
function buildRecipePrompt({selectedItems,kitchenStaples,equipment,cookingMethod,onePan,timeMinutes,effort,dietaryPreferences,goal,cuisine,cuisinePreferences=[],candidateCount=8}) {
  const selected=selectedItems.map(i=>({name:i.name,quantity:i.quantity,unit:i.unit,expiry:i.expiryDate||undefined})),staples=kitchenStaples.map(i=>i.name);
  const available=equipmentOptions(equipment),modes=available.map(equipmentMode).filter(x=>x!=='other'&&x!=='multiple');
  const timeText=Number.isFinite(timeMinutes)?`Maximum cooking time: ${timeMinutes} minutes.`:'No maximum cooking time.';
  const cuisineText=cuisine==='Any'?'Choose a suitable cuisine and vary cuisine across candidates where the ingredients support it.':`Every recipe must genuinely fit the requested cuisine: ${cuisine}. Use the canonical cuisine flag exactly.`;
  const cuisinePreferenceText=cuisinePreferences.length?`The cook's saved cuisine preferences are ${cuisinePreferences.join(', ')}. Prefer these when cuisine is Any and never present a narrow regional list as the complete set of cuisines.`:'No saved broad cuisine preferences.';
  const equipmentText=available.includes('No preference')?'No equipment preference was provided; choose reasonable equipment.':`Available equipment/methods (choose an appropriate subset for each recipe; do not use every selected item): ${available.join(', ')}. Every recipe must use only available cooking equipment. ${modes.length===1?`The only available cooking method is ${modes[0]}; recipes must be compatible with it.`:''} ${available.some(x=>equipmentMode(x)==='one-pan')?'Any recipe choosing One pan must do all prep and cooking in the same pan.':''} ${available.some(x=>equipmentMode(x)==='no-cook')?'No-cook is available as an option; any recipe flagged No-cook must not heat or cook.':''} ${available.some(x=>equipmentMode(x)==='multiple')?'Multiple pans/pots are available when useful.':''}`;
  return `You are PantryPal's recipe engine. Generate exactly ${candidateCount} genuinely different recipe candidates in one response. Do not make title variations of one dish or change only its seasoning. Vary recipe structure, preparation, cooking technique, and flavor profile; vary cuisines only where compatible with the user's cuisine choice and ingredients. Make practical, satisfying meal ideas. When only one ingredient is selected, make an appropriate snack, side, accompaniment, breakfast, or light meal; do not misrepresent a condiment/tempering as a complete dinner. Require a different dish family for each candidate. Do not create an ingredient or seasoning variation of an existing candidate under a new title. Keep every idea useful.

SELECTED PANTRY INGREDIENTS (the only tracked ingredients available):\n${JSON.stringify(selected)}

AVAILABLE KITCHEN STAPLES (only these may be used beyond selected pantry ingredients):\n${JSON.stringify(staples)}

USER PREFERENCES:\nCuisine: ${cuisine}. ${cuisinePreferenceText} Effort preference: ${effort}. Goal: ${goal}. Dietary preferences: ${dietaryPreferences.length?dietaryPreferences.join(', '):'none supplied'}.

EQUIPMENT AVAILABLE TO THE USER (choose a suitable subset per recipe):\n${equipmentText}

TIME FILTER:\n${timeText} The timeMinutes field must be a realistic total preparation and cooking estimate, not an arbitrary label. Do not exceed the maximum when one is provided.

${cuisineText}

For a high-protein goal, prioritize protein ingredients that are actually present in selected pantry or listed staples. Do not invent paneer, eggs, tofu, soy, meat, beans, or other protein foods. If available ingredients cannot support a high-protein meal, generate the best honest match; the backend will label its protein level accurately. Use available kitchen staples naturally, but never use unlisted staples or invent other ingredients. Every ingredient's source MUST be exactly one of "selected", "kitchen_staple", or "optional". "selected" means the ingredient name matches an item in SELECTED PANTRY INGREDIENTS; "kitchen_staple" means it matches an item in AVAILABLE KITCHEN STAPLES; "optional" means it is explicitly optional and still matches one of those two available lists. Source is a classification, never an ingredient name: do not use values such as "pantry", "spinach", or any other string. Use selected pantry ingredients as the center of each recipe. Do not repeat an ingredient or list unused ingredients.

Return JSON only as an array of ${candidateCount} recipe objects. Each recipe has only these culinary fields: title, description, cuisine, servings, timeMinutes, equipment (array), ingredients (array of {name,amount,source}), steps (array), substitutions (array), tips (array). Example ingredient entries: {"name":"spinach","amount":"1 cup","source":"selected"} and {"name":"cumin seeds","amount":"1 tsp","source":"kitchen_staple"}. Never put "pantry" or an ingredient name in source. Do not provide score, nutrition gram estimates, ID, persistence fields, or application metadata. Keep descriptions to 1-2 sentences and steps to 3-6 concise instructions. Each recipe's equipment array should name only the cooking appliance/method selected for that recipe.`;
}
function fallbackRecipes(req, selectedItems, kitchenStaples=[]) {
  if(!selectedItems.length)return [];
  const classify=item=>{
    const n=norm(item.name),c=norm(item.category);
    if(/pancake|batter mix/.test(n))return 'pancake-mix';
    if(/spinach|kale|chard|collard|arugula|lettuce/.test(n))return 'leafy-green';
    if(/egg/.test(n))return 'eggs';if(/paneer/.test(n))return 'paneer';if(/cheese/.test(n))return 'cheese';if(/tofu/.test(n))return 'tofu';
    if(/chicken|fish|meat|turkey|beef|pork/.test(n))return 'meat-protein';
    if(/chickpea|lentil|bean|pea/.test(n))return 'legume';
    if(/rice/.test(n))return 'rice';if(/pasta|noodle|macaroni/.test(n))return 'pasta-noodle';if(/bread|toast|wrap|tortilla|roti/.test(n))return 'bread-wrap';
    if(/apple|banana|orange|mango|berry|lemon|lime|fruit/.test(n))return 'fruit';
    if(/sauce|ketchup|soy sauce|chutney|paste/.test(n))return 'sauce-condiment';if(/spice|masala|cumin|pepper|paprika|oregano|chili|chilli/.test(n))return 'spice';
    if(/tomato|onion|potato|capsicum|bell pepper|carrot|broccoli|garlic|ginger|cucumber|zucchini|mushroom|cauliflower|corn/.test(n))return 'vegetable';
    if(/oat|flour|grain/.test(n)||c==='grains')return 'grain';if(c==='fruits')return 'fruit';if(c==='vegetables')return 'vegetable';if(c==='protein')return 'meat-protein';return 'other';
  };
  const kinds=selectedItems.map(classify),find=k=>selectedItems.find(i=>classify(i)===k),all=selectedItems,names=all.map(i=>i.name);
  const selectedEquipment=equipmentOptions(req.equipment).find(x=>x!=='No preference')||text(req.cookingMethod,60)||'No preference';
  let mode=equipmentMode(selectedEquipment);if(mode==='other')mode='stovetop';
  const onePan=mode==='one-pan'||Boolean(req.onePan);
  if(onePan)mode='one-pan';
  const vessel=mode==='one-pan'?'one skillet':mode==='one-pot'?'one pot':mode==='stovetop'?'stovetop skillet':mode==='microwave'?'microwave and microwave-safe container':mode==='oven'?'oven and oven-safe dish':mode==='air-fryer'?'air fryer':mode==='no-cook'?'no cooking equipment':'stovetop skillet';
  const maxTime=parseTimeLimit(req.time)??180;
  const estimate=()=>Math.max(8,...all.map(i=>/dry (?:bean|rice|lentil)|uncooked rice/i.test(i.name)?35:/pasta|noodle|potato|pancake mix/i.test(i.name)?15:/carrot|broccoli|cauliflower/i.test(i.name)?12:8));
  const tomato=all.find(i=>/tomato/.test(norm(i.name))),eggs=find('eggs'),paneer=find('paneer'),cheese=find('cheese'),mix=find('pancake-mix'),rice=find('rice'),pasta=find('pasta-noodle'),bread=find('bread-wrap');
  const greens=all.filter((_,i)=>['leafy-green','vegetable'].includes(kinds[i]));
  const legumes=all.filter((_,i)=>kinds[i]==='legume');
  const cookedRice=rice&&/cooked|leftover|ready/i.test(rice.name);
  let dish='Selected Ingredient Preparation',steps=[],minutes=estimate(),basicNames=[];
  if(mix){dish='Pancake Mix';basicNames=['water'];}
  else if(eggs&&tomato){dish='Tomato Egg';minutes=15;}
  else if(paneer&&greens.length){dish='Spinach Paneer';minutes=15;}
  else if(tomato&&cheese&&bread){dish='Tomato Cheese Toast';minutes=15;}
  else if(tomato&&cheese){dish='Tomato Cheese';minutes=12;}
  else if(rice&&greens.length){dish=cookedRice?'Vegetable Rice':'One-Pan Vegetable Rice';basicNames=cookedRice?[]:['water'];minutes=cookedRice?15:35;}
  else if(pasta&&greens.length){dish='Vegetable Pasta';basicNames=['water'];minutes=25;}
  else if(rice){dish=cookedRice?'Warm Skillet Rice':'One-Pan Rice';basicNames=cookedRice?[]:['water'];minutes=cookedRice?10:35;}
  else if(pasta){dish='One-Pan Pasta';basicNames=['water'];minutes=25;}
  else if(paneer){dish='Paneer';minutes=10;}
  else if(tomato){dish='Tomato';minutes=10;}
  else if(eggs){dish='Selected Ingredient Eggs';minutes=12;}
  else if(legumes.length){dish='Warm Legume';minutes=12;}
  else if(greens.length){dish=greens.every(i=>classify(i)==='leafy-green')?'Wilted Greens':'Vegetable';minutes=12;}
  else if(names.length===1&&classify(all[0])==='fruit'){dish=`Warm ${all[0].name}`;minutes=8;}
  else if(kinds.every(k=>['spice','sauce-condiment'].includes(k)))return [];

  const foods=names.join(' and ');
  if(mode==='microwave'){
    if(eggs&&tomato){dish='Microwave Tomato Egg';steps=[`Place chopped ${tomato.name} in a microwave-safe container and microwave on HIGH for 45 seconds.`,`Stir, add the eggs directly to the container, and beat them into the tomatoes.`,`Microwave for 30 seconds, stir, then repeat in 15-second bursts until the eggs are fully set.`];minutes=4;}
    else if(paneer&&greens.length){dish='Microwave Spinach Paneer';steps=[`Put ${greens.map(i=>i.name).join(' and ')} in a microwave-safe container and microwave on HIGH for 60 seconds.`,`Stir in ${paneer.name} and cover loosely.`,`Microwave for 45 seconds more, stir, and check that the paneer is hot.`];minutes=3;}
    else if(tomato&&cheese){dish='Microwave Tomato Cheese Melt';steps=[`Slice ${tomato.name} into a microwave-safe dish and microwave on HIGH for 60 seconds.`,`Stir, spread ${cheese.name} over the tomatoes, and microwave for 30 seconds.`,`Check that the cheese has melted; microwave in 10-second bursts if needed.`];minutes=2;}
    else if(mix){dish='Microwave Pancake Mug';steps=[`Put ${mix.name} in a microwave-safe mug and stir in enough water to make a thick batter.`,`Microwave on HIGH for 60 seconds.`,`Check the center; microwave in 10-second bursts until the batter is set, then let it stand for one minute.`];minutes=2;}
    else if(rice&&greens.length&&cookedRice){dish='Microwave Vegetable Rice';steps=[`Put ${foods} in a microwave-safe container and cover loosely.`,`Microwave on HIGH for 90 seconds, then stir.`,`Microwave for another 30 seconds if the rice is not steaming hot throughout.`];minutes=3;}
    else if(tomato){dish='Microwave Soft Tomatoes';steps=[`Cut ${foods} into a microwave-safe container.`,`Cover loosely and microwave on HIGH for 60 seconds.`,`Stir and microwave in 20-second bursts until softened.`];minutes=2;}
    else if(all.length===1&&classify(all[0])==='fruit'){dish=`Microwave ${all[0].name}`;steps=[`Slice ${all[0].name} into a microwave-safe container.`,`Microwave on HIGH for 30 seconds.`,`Check the texture and heat for another 10 seconds if desired.`];minutes=1;}
    else return [];
  } else if(mode==='oven'){
    if(mix){dish='Oven-Baked Pancake Mix';basicNames=['water'];steps=[`Heat the oven to 190°C and stir ${mix.name} with enough water to make a thick batter.`,`Pour the batter into an oven-safe dish.`,`Bake for 12–15 minutes, until the center is set.`];minutes=20;}
    else if(tomato&&cheese){dish='Oven Tomato Cheese Bake';steps=[`Heat the oven to 200°C. Slice ${tomato.name} into an oven-safe dish.`,`Scatter ${cheese.name} over the tomatoes.`,`Bake for 10–12 minutes, until the tomatoes are soft and the cheese is melted.`];minutes=18;}
    else if(eggs&&tomato){dish='Oven Tomato Egg Bake';steps=[`Heat the oven to 190°C. Put sliced ${tomato.name} in an oven-safe dish.`,`Make spaces, crack the eggs into them, and cover the dish.`,`Bake until the whites are set, about 12–15 minutes.`];minutes=20;}
    else if(paneer&&greens.length){dish='Oven Spinach Paneer';steps=[`Heat the oven to 190°C. Put ${greens.map(i=>i.name).join(' and ')} and ${paneer.name} in an oven-safe dish.`,`Cover the dish and bake for 12 minutes.`,`Check that the paneer is hot and the greens are wilted before serving.`];minutes=18;}
    else return [];
  } else if(mode==='air-fryer'){
    if(tomato&&cheese){dish='Air-Fryer Tomato Cheese';steps=[`Place sliced ${tomato.name} in an air-fryer-safe dish and top with ${cheese.name}.`,`Air fry at 180°C for 5 minutes.`,`Check that the tomatoes are soft and the cheese has melted; air fry for one more minute if needed.`];minutes=8;}
    else if(paneer&&greens.length){dish='Air-Fryer Spinach Paneer';steps=[`Put ${paneer.name} and ${greens.map(i=>i.name).join(' and ')} in an air-fryer-safe dish.`,`Air fry at 180°C for 6 minutes, stirring once halfway through.`,`Check that the paneer is hot and the greens are wilted.`];minutes=9;}
    else if(mix){dish='Air-Fryer Pancake Mix Cakes';basicNames=['water'];steps=[`Mix ${mix.name} with enough water to make a thick batter, then spoon it into a small air-fryer-safe dish.`,`Air fry at 160°C for 8 minutes.`,`Check the center is set; cook for another minute if needed.`];minutes=11;}
    else if(eggs&&tomato){dish='Air-Fryer Tomato Eggs';steps=[`Put sliced ${tomato.name} in an air-fryer-safe dish and add the eggs.`,`Air fry at 160°C for 8 minutes.`,`Check that the eggs are fully set before eating; continue in short intervals if needed.`];minutes=11;}
    else return [];
  } else if(mode==='no-cook'){
    if(eggs||mix||rice&&!cookedRice||pasta||kinds.some(k=>['meat-protein'].includes(k)))return [];
    if(tomato&&cheese){dish='No-Cook Tomato Cheese Bites';steps=[`Slice ${tomato.name} and ${cheese.name}.`,`Layer the selected tomato and cheese slices together.`,`Serve the tomato-cheese bites cool.`];minutes=5;}
    else if(paneer&&greens.length){dish='No-Cook Paneer and Spinach Plate';steps=[`Rinse and dry the selected ${greens.map(i=>i.name).join(' and ')}.`,`Cut ${paneer.name} into bite-size pieces and place it with the greens.`,`Toss together and serve without heating.`];minutes=5;}
    else if(bread&&cheese){dish='No-Cook Cheese and Bread Assembly';steps=[`Tear or slice ${bread.name} and ${cheese.name}.`,`Layer the selected cheese onto the bread.`,`Serve without heating.`];minutes=3;}
    else if(greens.length||tomato){dish=`No-Cook ${dish}`;steps=[`Rinse and dry the selected ${foods}.`,`Slice or tear the selected ingredients into bite-size pieces.`,`Arrange together and serve without heating.`];minutes=5;}
    else return [];
  } else {
    const vesselWord=mode==='one-pot'?'pot':'skillet';
    if(mix){dish='Pan Pancakes';steps=[`Stir ${mix.name} with enough water directly in the ${vesselWord} until smooth.`,`Pour a small round of batter into the warm ${vesselWord} and cook until bubbles appear.`,`Turn and cook the other side until set.`];minutes=15;}
    else if(eggs&&tomato){dish='Stovetop Tomato Eggs';steps=[`Put sliced ${tomato.name} in the ${vesselWord} and cook over medium heat until softened.`,`Add the eggs and stir gently through the tomatoes.`,`Cook until the eggs are fully set.`];minutes=12;}
    else if(paneer&&greens.length){dish='Stovetop Spinach Paneer';steps=[`Add ${paneer.name} to the ${vesselWord} and turn over medium heat until warm.`,`Add ${greens.map(i=>i.name).join(' and ')} and stir until wilted.`,`Continue until the paneer is hot and the greens are tender.`];minutes=12;}
    else if(tomato&&cheese){dish=bread?'Stovetop Tomato Cheese Toast':'Stovetop Tomato Cheese Melt';steps=bread?[`Toast ${bread.name} in the ${vesselWord} over medium-low heat.`,`Turn it, add sliced ${tomato.name} and ${cheese.name}, and cover.`,`Cook until the bread is crisp and the cheese is melted.`]:[`Cook sliced ${tomato.name} in the ${vesselWord} until juicy.`,`Add ${cheese.name} and cover the same vessel.`,`Cook gently until the cheese softens and the tomatoes are hot.`];minutes=12;}
    else if(rice&&greens.length){dish=cookedRice?'Stovetop Vegetable Rice':'One-Pot Vegetable Rice';basicNames=cookedRice?[]:['water'];steps=cookedRice?[`Cook ${greens.map(i=>i.name).join(' and ')} in the ${vesselWord} until tender.`,`Stir in ${rice.name} and heat through.`,`Stir until the rice is steaming hot.`]:[`Add ${rice.name}, ${greens.map(i=>i.name).join(' and ')}, and water to the ${vesselWord}.`,`Cover and simmer until the rice is tender, adding water if needed.`,`Check the rice is fully cooked before serving.`];minutes=cookedRice?15:35;}
    else if(pasta&&greens.length){dish='Stovetop Vegetable Pasta';basicNames=['water'];steps=[`Add ${pasta.name}, ${greens.map(i=>i.name).join(' and ')}, and water to the ${vesselWord}.`,`Simmer, stirring often and adding water as needed until the pasta is tender.`,`Cook until the pasta is done and excess liquid reduces.`];minutes=25;}
    else if(eggs){dish='Stovetop Selected-Ingredient Eggs';steps=[`Warm the ${vesselWord} and add ${names.filter(n=>n!==eggs.name).join(' and ')||eggs.name}.`,`Add the eggs and scramble with the selected ingredients.`,`Cook until the eggs are fully set.`];minutes=12;}
    else if(paneer){dish='Stovetop Paneer';steps=[`Warm the ${vesselWord} and add ${paneer.name}.`,`Turn the paneer until hot on all sides.`,`Remove from heat and serve.`];minutes=10;}
    else if(tomato&&cheese===undefined){dish='Stovetop Tomato';steps=[`Slice ${tomato.name} into the ${vesselWord}.`,`Cook over medium heat, stirring as it softens and releases its juices.`,`Continue until hot and tender.`];minutes=10;}
    else if(greens.length){dish='Stovetop Greens';steps=[`Add ${greens.map(i=>i.name).join(' and ')} to the ${vesselWord}.`,`Stir over medium heat until the selected vegetables begin to soften.`,`Cook until tender; add water only if they begin to stick.`];minutes=12;basicNames=['water'];}
    else if(rice){dish=cookedRice?'Stovetop Rice':'One-Pot Rice';basicNames=cookedRice?[]:['water'];steps=cookedRice?[`Add ${rice.name} to the ${vesselWord}.`,`Stir over low heat until steaming hot throughout.`,`Remove from heat and serve.`]:[`Add ${rice.name} and water to the ${vesselWord}.`,`Cover and simmer until the rice is tender, adding water if needed.`,`Check that no hard grains remain.`];minutes=cookedRice?10:35;}
    else if(pasta){dish='One-Pot Pasta';basicNames=['water'];steps=[`Add ${pasta.name} and water to the ${vesselWord}.`,`Simmer, stirring often and adding water as needed until tender.`,`Cook until the pasta is done and excess liquid reduces.`];minutes=25;}
    else if(all.length===1&&classify(all[0])==='fruit'){dish=`Warm ${all[0].name}`;steps=[`Slice ${all[0].name} into the ${vesselWord}.`,`Warm gently while turning the pieces once.`,`Remove from heat when tender.`];minutes=8;}
    else {dish='Selected Ingredients';steps=[`Put ${foods} in the ${vesselWord}.`,`Cook over medium heat, stirring until the selected ingredients are tender or hot throughout.`,`Remove from heat and serve.`];}
  }
  if(minutes>maxTime)return [];
  const mentioned=`${dish} ${steps.join(' ')}`.toLowerCase();
  const usedItems=all.filter(item=>mentioned.includes(item.name.toLowerCase()));
  if(!usedItems.length)return [];
  const ingredients=[...usedItems.map(i=>({name:i.name,quantity:i.quantity==null?'use what you have':`${i.quantity} ${i.unit||''}`.trim()}))];
  const basicLabels={water:'as needed for this recipe',salt:'to taste if desired',oil:'a little if needed'};
  for(const name of [...new Set(basicNames)])if(steps.some(step=>new RegExp(`\\b${name}\\b`,'i').test(step)))ingredients.push({name,quantity:basicLabels[name],pantryBasic:true});
  const title=`${dish}${mode==='microwave'?' · Microwave':mode==='oven'?' · Oven':mode==='air-fryer'?' · Air Fryer':mode==='no-cook'?' · No-Cook':mode==='one-pan'?' · One Pan':mode==='stovetop'?' · Stovetop':''}`;
  const proteinNames=usedItems.filter(i=>['eggs','paneer','cheese','tofu','meat-protein','legume'].includes(classify(i))).map(i=>i.name);
  const raw={title,description:`${dish} made from only the ingredients used from What to Cook, using ${vessel}.`,cuisine:text(req.cuisine,50)||'Everyday',style:text(req.cuisine,50)||'Everyday',protein:proteinNames.length?`Selected protein ingredients: ${proteinNames.join(', ')}`:'',timeMinutes:minutes,servings:1,equipment:vessel,onePan,pantryMatch:0,mealEfficiencyScore:0,scoreBreakdown:{wasteSaved:0,timeEfficiency:0,ingredientCoverage:0},ingredients,steps};
  const checked=validateRecipe(raw,selectedItems,req.goal,selectedEquipment,maxTime,kitchenStaples);
  if(!checked.recipe){console.warn('[recipes] fallback_validation_failed',JSON.stringify({title,reason:checked.reason}));return [];}
  checked.recipe.generatedBy='pantry-combination-fallback';return [checked.recipe];
}
async function api(req,res,url) {
  const p=url.pathname, method=req.method;
  try {
    if(p==='/api/debug/gemma-recipe'&&method==='POST'){
      if(!isLocalDevelopmentRequest(req))return json(res,404,{error:'Route not found.'});if(!process.env.GOOGLE_AI_API_KEY||process.env.PANTRYPAL_GEMMA_DISABLED==='1')throw new HttpError(503,'Gemma is not configured for this development server.');
      const b=await body(req),selectedItems=Array.isArray(b.selectedIngredients)?b.selectedIngredients.slice(0,50).map(i=>({name:text(i?.name,80),quantity:i?.quantity??null,unit:text(i?.unit,30),freshnessStatus:'unknown'})).filter(i=>i.name):[];if(!selectedItems.length)throw new HttpError(400,'Provide at least one selected ingredient.');
      const kitchenStaples=(Array.isArray(b.kitchenStaples)?b.kitchenStaples:[]).slice(0,60).map(x=>({name:text(typeof x==='string'?x:x?.name,60),enabled:true})).filter(x=>x.name),equipment=equipmentOptions(b.equipment),cuisine=text(b.cuisine,50)||'Any',timeLimit=parseTimeLimit(b.timeMinutes??b.time),effort=text(b.effort,30)||'Easy',goal=text(b.goal,50)||'Surprise me',count=Math.min(8,Math.max(1,Number(b.count)||6)),requestedCandidates=Math.min(8,count+2),dietaryPreferences=(Array.isArray(b.dietaryPreferences)?b.dietaryPreferences:[]).map(x=>text(x,60)).filter(Boolean).slice(0,8);
      let rawModelResponse='';const log=(event,details={})=>{if(event==='raw_model_output')rawModelResponse=details.output;console.info('[recipes/gemma]',event,JSON.stringify(details));};
      const prompt=buildRecipePrompt({selectedItems,kitchenStaples,cuisine,equipment,timeMinutes:timeLimit,effort,dietaryPreferences,goal,candidateCount:requestedCandidates});
      try{const data=await gemma(prompt,log,1,true),result=validateCandidateSet(data,selectedItems,goal,equipment,timeLimit,kitchenStaples,cuisine,count,log);return json(res,200,{source:'gemma',requestedCandidates,rawModelResponse,parsedCandidates:result.candidates,validation:{valid:result.valid.length>0,validCount:result.valid.length,rejected:result.rejected,duplicateCount:result.duplicateCount},normalizedRecipes:result.ranked,parsedRecipe:result.candidates[0]||null,normalizedRecipe:result.ranked[0]||null});}
      catch(error){return json(res,502,{source:'gemma',requestedCandidates,rawModelResponse,parsedCandidates:null,validation:{valid:false,validCount:0,rejected:[{reason:error?.message||String(error)}]}});}
    }
    if (p==='/api/status'&&method==='GET') return json(res,200,{ok:true,storage:mongoStatus,ai:process.env.GOOGLE_AI_API_KEY?'gemma':'pantry-matcher',model:process.env.GOOGLE_AI_API_KEY?RECIPE_MODEL:null});
    if (p==='/api/pantry'&&method==='GET') return json(res,200,{items:state.pantry.map(i=>({...i,freshnessStatus:freshness(i)}))});
    if (p==='/api/pantry/parse'&&method==='POST') { const b=await body(req); const items=parseIngredients(b.text); if (!items.length) throw new HttpError(400,'I could not find ingredient names. Try separating them with commas.'); return json(res,200,{items:items.map(i=>({...i,name:text(i.name,80)})),provider:'local-parser'}); }
    if (p==='/api/pantry'&&method==='POST') { const b=await body(req); const inputs=Array.isArray(b.items)?b.items:[b]; if (!inputs.length||inputs.length>50) throw new HttpError(400,'Add between 1 and 50 ingredients at a time.'); const added=inputs.map(x=>pantryItem(x)); state.pantry.push(...added); await persist(); return json(res,201,{items:added}); }
    if (p.startsWith('/api/pantry/')&&method==='PATCH') { const id=p.split('/')[3], i=state.pantry.findIndex(x=>x.id===id); if(i<0) return json(res,404,{error:'Ingredient not found.'}); state.pantry[i]=pantryItem({...state.pantry[i],...await body(req),id}); await persist(); return json(res,200,{item:state.pantry[i]}); }
    if (p.startsWith('/api/pantry/')&&method==='DELETE') { const id=p.split('/')[3], previous=state.pantry; state.pantry=previous.filter(x=>x.id!==id); if(previous.length===state.pantry.length)return json(res,404,{error:'Ingredient not found.'}); try{await persist()}catch(error){state.pantry=previous;throw error} return json(res,200,{ok:true}); }
    if (p.endsWith('/use')&&method==='POST') { const id=p.split('/')[3], i=state.pantry.findIndex(x=>x.id===id); if(i<0)return json(res,404,{error:'Ingredient not found.'}); const b=await body(req), amount=Number(b.quantity)||1; if(state.pantry[i].quantity==null){state.pantry.splice(i,1);}else{state.pantry[i].quantity=Math.max(0,state.pantry[i].quantity-amount);if(!state.pantry[i].quantity)state.pantry.splice(i,1);} await persist();return json(res,200,{items:state.pantry}); }
    if (p==='/api/recipes/generate'&&method==='POST') {
      const b=await body(req);if(!Array.isArray(b.ingredients)||!b.ingredients.length)throw new HttpError(400,'Select at least one pantry ingredient.');if(b.ingredients.length>50)throw new HttpError(400,'Select no more than 50 ingredients.');
      const ids=[...new Set(b.ingredients.map(x=>typeof x==='string'?x:x?.id))];if(ids.length!==b.ingredients.length||ids.some(id=>!validId(id)))throw new HttpError(400,'Ingredient selection is invalid.');
      const selectedItems=ids.map(id=>state.pantry.find(x=>x.id===id));if(selectedItems.some(x=>!x))throw new HttpError(400,'One selected ingredient is no longer in your pantry.');
      const maxTime=parseTimeLimit(b.time??b.timeMinutes),equipment=equipmentOptions(b.equipment),requestedCount=Math.min(8,Math.max(1,Number(b.count)||6)),requestedCandidates=Math.min(8,requestedCount+2);
      const dietaryInput=b.dietaryPreferences??b.dietary??state.preferences?.dietaryPreferences??state.preferences?.dietary??[],dietaryPreferences=(Array.isArray(dietaryInput)?dietaryInput:typeof dietaryInput==='string'?dietaryInput.split(/[,;]+/):[]).map(x=>text(x,60)).filter(Boolean).slice(0,8);
      const cuisine=text(b.cuisine,50)||'Any',cuisinePreferences=[...(Array.isArray(b.cuisinePreferences)?b.cuisinePreferences:[]),...(state.preferences.cuisines||[]),...(state.preferences.indianCuisines||[])].map(x=>text(x,40)).filter(Boolean),effort=text(b.effort,30)||'Easy',goal=text(b.goal,50)||'Surprise me',kitchenStaples=(state.preferences.kitchenStaples||[]).filter(i=>i.enabled!==false),log=(event,details={})=>console.info('[recipes/gemma]',event,JSON.stringify(details));
      console.info('[recipes] generation_request',JSON.stringify({requestedCandidates,returnCount:requestedCount,selected:selectedItems.map(i=>i.name),kitchenStaplesCount:kitchenStaples.length,cuisine,equipment,timeLimit:maxTime??'No preference',effort,dietaryPreferences,goal}));
      let generated=[],generationFailureReason='',gemmaAttempted=false,rejected=[],receivedCount=0,validCount=0,duplicateCount=0;
      if(!process.env.GOOGLE_AI_API_KEY||process.env.PANTRYPAL_GEMMA_DISABLED==='1')log('request_skipped',{model:RECIPE_MODEL,reason:process.env.PANTRYPAL_GEMMA_DISABLED==='1'?'disabled for this run':'GOOGLE_AI_API_KEY is not configured'});
      else{gemmaAttempted=true;try{const prompt=buildRecipePrompt({selectedItems,kitchenStaples,cuisine,cuisinePreferences,equipment,timeMinutes:maxTime,effort,dietaryPreferences,goal,candidateCount:requestedCandidates}),data=await gemma(prompt,log,1,isLocalDevelopmentRequest(req)),checked=validateCandidateSet(data,selectedItems,goal,equipment,maxTime,kitchenStaples,cuisine,requestedCount,log);generated=checked.ranked;rejected=checked.rejected;receivedCount=checked.candidates.length;validCount=checked.valid.length;duplicateCount=checked.duplicateCount;if(!generated.length)generationFailureReason=rejected.map(x=>x.reason).join('; ')||'Gemma returned no candidate recipes';log('candidate_validation_summary',{requestedCandidates,receivedCandidates:checked.candidates.length,validCandidates:checked.valid.length,rejectedCandidates:checked.rejected.length,duplicateCandidates:checked.duplicateCount,returnedCandidates:generated.length});}catch(err){generationFailureReason=err?.message||String(err);log('request_caught_error',{model:RECIPE_MODEL,error:generationFailureReason});}}
      const recipes=generated.length?generated:fallbackRecipes({...b,equipment,time:maxTime},selectedItems,kitchenStaples);if(!generated.length){generationFailureReason||=gemmaAttempted?'Gemma returned no valid candidate':'Gemma is not configured';log('fallback_used',{reason:generationFailureReason,selectedCount:selectedItems.length});}
      const source=generated.length?'gemma':'fallback';console.info('[recipes] generation_summary',JSON.stringify({source,model:source==='gemma'?RECIPE_MODEL:null,requestedCandidates,receivedCandidates:receivedCount,validCandidates:validCount,rejectedCandidates:rejected.length,duplicateCandidates:duplicateCount,returnedCandidates:recipes.length,fallbackReason:source==='fallback'?generationFailureReason:undefined}));
      for(const recipe of recipes)console.info('[recipes] generation_success',JSON.stringify({source,model:source==='gemma'?RECIPE_MODEL:null,selectedCount:selectedItems.length,kitchenStaplesCount:kitchenStaples.length,cuisine,equipment,goal,validation:source==='gemma',title:recipe.title,timeMinutes:recipe.timeMinutes,timeBucket:recipe.timeBucket,recipeEquipment:recipe.equipment,protein:recipe.protein,...(source==='fallback'?{fallbackReason:generationFailureReason}:{})}));
      const notice=source==='gemma'?'':gemmaAttempted&&receivedCount>0?"We couldn’t find a recipe that matched all your current constraints. Try relaxing the equipment, time, or cuisine filters.":'AI temporarily unavailable. Showing a basic pantry-based suggestion.';
      state.recipes.unshift(...recipes);state.recipes=state.recipes.slice(0,100);await persist();return json(res,200,{recipes,provider:source==='gemma'?'gemma':'pantry-matcher',notice,fallbackReason:source==='gemma'?undefined:generationFailureReason,requestedCandidates,receivedCandidates:receivedCount,validCandidates:validCount,rejectedCandidates:rejected.length,duplicateCandidates:duplicateCount,returnedCandidates:recipes.length});
    }
    if (p==='/api/recipes'&&method==='GET') return json(res,200,{recipes:state.recipes});
    if (p==='/api/recipes/recently-made'&&method==='GET') {
      const items=[...state.recipeHistory].sort((a,b)=>Date.parse(b.madeAt)-Date.parse(a.madeAt)).map(entry=>({...structuredClone(entry.recipe||state.recipes.find(r=>r.id===entry.recipeId)||{}),madeAt:entry.madeAt,historyId:entry.id})).filter(r=>r.id);
      return json(res,200,{items});
    }
    if (p.startsWith('/api/recipes/')&&p.endsWith('/made')&&method==='POST') {
      const id=p.split('/')[3],recipe=state.recipes.find(r=>r.id===id);if(!recipe)return json(res,404,{error:'Recipe not found.'});
      const madeAt=new Date().toISOString(),entry={id:randomUUID(),recipeId:id,madeAt,recipe:structuredClone(recipe)};state.recipeHistory.push(entry);state.recipeHistory=state.recipeHistory.slice(-100);
      const usedNames=new Set((recipe.pantryUsed||[]).map(norm));
      for(const item of state.pantry){if(!usedNames.has(norm(item.name)))continue;item.quantity=item.quantity==null?0:Math.max(0,item.quantity-1);item.updatedAt=madeAt;item.freshnessStatus=freshness(item);}
      state.pantry=state.pantry.filter(item=>item.quantity>0);await persist();
      return json(res,201,{item:{...recipe,madeAt,historyId:entry.id},pantry:state.pantry});
    }
    if (p==='/api/feedback'&&method==='GET') return json(res,200,{items:state.feedback});
    if (p.startsWith('/api/recipes/')&&method==='PATCH') {const id=p.split('/')[3],r=state.recipes.find(x=>x.id===id);if(!r)return json(res,404,{error:'Recipe not found.'});const b=await body(req);r.saved=Boolean(b.saved);r.updatedAt=new Date().toISOString();await persist();return json(res,200,{recipe:r});}
    if (p.startsWith('/api/recipes/')&&p.endsWith('/feedback')&&method==='POST') {const id=p.split('/')[3],b=await body(req);if(!['Loved it','Good','Okay','Not for me'].includes(b.rating))throw new HttpError(400,'Choose a meal rating.');state.feedback.push({id:randomUUID(),recipeId:id,rating:b.rating,reasons:(b.reasons||[]).map(x=>text(x,40)).slice(0,5),createdAt:new Date().toISOString()});await persist();return json(res,201,{ok:true,preferenceSignals:state.feedback.length});}
    if (p==='/api/preferences'&&method==='GET') return json(res,200,state.preferences);
    if (p==='/api/preferences'&&method==='PATCH') {const b=await body(req);const profile=Object.hasOwn(KITCHEN_PROFILE_STAPLES,b.kitchenProfile)?b.kitchenProfile:state.preferences.kitchenProfile;let kitchenStaples=state.preferences.kitchenStaples;if(Array.isArray(b.kitchenStaples)){const seen=new Set();kitchenStaples=b.kitchenStaples.slice(0,60).map(item=>({name:text(typeof item==='string'?item:item?.name,60),enabled:typeof item==='string'?true:item?.enabled!==false,custom:Boolean(item?.custom)})).filter(item=>{const key=comparableIngredientName(item.name);if(!key||seen.has(key))return false;seen.add(key);return true;});}state.preferences={...state.preferences,...b,updatedAt:new Date().toISOString(),kitchenProfile:profile,kitchenStaples,goals:Array.isArray(b.goals)?b.goals.slice(0,8):state.preferences.goals,cuisines:Array.isArray(b.cuisines)?b.cuisines.slice(0,4):state.preferences.cuisines,indianCuisines:Array.isArray(b.indianCuisines)?b.indianCuisines.slice(0,12):state.preferences.indianCuisines,equipment:Array.isArray(b.equipment)?b.equipment.slice(0,8):state.preferences.equipment,reminders:{...state.preferences.reminders,...(b.reminders||{})}};await persist();return json(res,200,state.preferences);}
    if (p==='/api/meal-plan'&&method==='GET') return json(res,200,{items:state.mealPlan});
    if (p==='/api/meal-plan'&&method==='POST') {const b=await body(req);const r=state.recipes.find(x=>x.id===b.recipeId);if(!r)throw new HttpError(400,'Choose a recipe to add it to your plan.');const day=optionalDate(b.day??b.date,'Meal date')||new Date().toISOString().slice(0,10);state.mealPlan.push({id:randomUUID(),recipeId:r.id,title:r.title,day,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});await persist();return json(res,201,{items:state.mealPlan});}
    if (p.startsWith('/api/meal-plan/')&&method==='DELETE') {const id=p.split('/')[3],before=state.mealPlan.length;state.mealPlan=state.mealPlan.filter(x=>x.id!==id);if(before===state.mealPlan.length)return json(res,404,{error:'Planned meal not found.'});await persist();return json(res,200,{items:state.mealPlan});}
    return json(res,404,{error:'Route not found.'});
  } catch(err) { const status=err instanceof HttpError?err.status:500; if(status>=500)console.error('PantryPal request failed:',err?.name||'Error'); return json(res,status,{error:err instanceof HttpError?err.message:'Something went wrong. Please try again.'}); }
}
await initStore();
const server=http.createServer(async(req,res)=>{ const url=new URL(req.url,'http://localhost'); if(url.pathname.startsWith('/api/'))return api(req,res,url); const relative=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1)); const file=path.resolve(publicDir,relative); if(!file.startsWith(publicDir+path.sep)&&file!==path.join(publicDir,'index.html'))return json(res,403,{error:'Forbidden'}); try{const data=await readFile(file);res.writeHead(200,{'content-type':mime[path.extname(file)]||'application/octet-stream'});res.end(data);}catch{res.writeHead(404,{'content-type':'text/plain'});res.end('Not found');}});
server.listen(Number(process.env.PORT)||3000,process.env.HOST||'0.0.0.0',()=>console.log(`PantryPal ready on http://${process.env.HOST||'localhost'}:${process.env.PORT||3000} (${mongoStatus})`));
for (const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>server.close(()=>repository?.close().catch(error=>console.error(`PantryPal storage shutdown failed (${error?.name||'error'}).`))));
