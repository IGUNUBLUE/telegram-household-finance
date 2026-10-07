/** Standalone CPU retrieval benchmark. Synthetic inputs only; no credentials,
 * database, Telegram, translation API or production config are accessed.
 * Run each mode in a fresh process to make RSS measurements comparable.
 */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {pipeline,env,AutoModel,AutoTokenizer} from '@huggingface/transformers';

const models={
 'gte-es':{model:'Xenova/gte-small',revision:'5927d1727bb12db490052a1b33265ad78058de08',dtype:'fp32',language:'es',dimension:384},
 'gte-en-manual':{model:'Xenova/gte-small',revision:'5927d1727bb12db490052a1b33265ad78058de08',dtype:'fp32',language:'en',dimension:384},
 'e5-es-q8':{model:'Xenova/multilingual-e5-small',revision:'761b726dd34fb83930e26aab4e9ac3899aa1fa78',dtype:'q8',language:'es',dimension:384,prefix:true},
 'minilm-es-q8':{model:'Xenova/paraphrase-multilingual-MiniLM-L12-v2',revision:'2c4055b12046f11709e9df2c122e59ffbdc2f900',dtype:'q8',language:'es',dimension:384},
 'gemma-es-q4':{model:'onnx-community/embeddinggemma-300m-ONNX',revision:'5090578d9565bb06545b4552f76e6bc2c93e4a66',dtype:'q4',language:'es',dimension:768,nativeSentence:true},
};
const [mode,fixturePath,cacheDirectory,outputPath]=process.argv.slice(2);
if(!models[mode]||!fixturePath||!cacheDirectory||!outputPath)throw Error('Usage: node script MODE FIXTURE CACHE OUTPUT');
const config=models[mode];
const bytes=await readFile(fixturePath),fixture=JSON.parse(bytes);
const ids=new Set(fixture.documents.map(d=>d.id));
if(ids.size!==fixture.documents.length||fixture.queries.some(q=>q.relevant.some(id=>!ids.has(id))))throw Error('Invalid fixture labels');
await mkdir(cacheDirectory,{recursive:true,mode:0o700});
env.logLevel=40;
const start=performance.now();
const options={
 revision:config.revision,dtype:config.dtype,device:'cpu',cache_dir:cacheDirectory,
 session_options:{intraOpNumThreads:1,interOpNumThreads:1,executionMode:'sequential'},
};
const extractor=config.nativeSentence?await AutoModel.from_pretrained(config.model,options):await pipeline('feature-extraction',config.model,options);
const tokenizer=config.nativeSentence?await AutoTokenizer.from_pretrained(config.model,options):undefined;
const loaded=performance.now();
const times={passage:[],query:[]};
const embed=async(text,kind)=>{
 const prefixed=config.nativeSentence?(kind==='query'?'task: search result | query: ':'title: none | text: ')+text:config.prefix?(kind==='query'?'query: ':'passage: ')+text:text;
 const before=performance.now();
 const vector=config.nativeSentence?(await extractor(await tokenizer(prefixed,{padding:true,truncation:true}))).sentence_embedding.tolist()[0]:(await extractor(prefixed,{pooling:'mean',normalize:true})).tolist()[0];
 const elapsed=performance.now()-before;
 if(vector.length!==config.dimension||vector.some(v=>!Number.isFinite(v))||Math.abs(Math.hypot(...vector)-1)>0.001)throw Error('Invalid embedding');
 return {vector,elapsed};
};
const cold=await embed(config.language==='en'?'warmup of a fictional financial memory':'warmup de un recuerdo financiero ficticio','query');
const documents=[];
for(const d of fixture.documents){const r=await embed(d[config.language],'passage');times.passage.push(r.elapsed);documents.push({...d,vector:r.vector});}
const results=[];
for(const q of fixture.queries){
 const r=await embed(q[config.language],'query');times.query.push(r.elapsed);
 const ranked=documents.map(d=>({id:d.id,score:r.vector.reduce((n,v,i)=>n+v*d.vector[i],0)})).sort((a,b)=>b.score-a.score);
 const index=ranked.findIndex(d=>q.relevant.includes(d.id));
 results.push({id:q.id,group:q.group,relevant:q.relevant,rank:index<0?null:index+1,top3:ranked.slice(0,3),elapsed_ms:r.elapsed});
}
// Recompute every query once: no embedding cache. This increases timing samples.
for(const q of fixture.queries){const r=await embed(q[config.language],'query');times.query.push(r.elapsed);}
const longInput=[];
const phrase=config.language==='en'?'Fictional household memory: grocery purchase and utilities paid from a bank account. ':'Recuerdo familiar ficticio: compra de mercado y pago de servicios desde una cuenta bancaria. ';
for(const chars of [200,600,1000]){const measurements=[];for(let i=0;i<3;i++){const r=await embed(phrase.repeat(20).slice(0,chars),'passage');measurements.push(r.elapsed);}longInput.push({chars,elapsed_ms:measurements});}
const stats=values=>{const s=[...values].sort((a,b)=>a-b);return {n:s.length,min_ms:s[0],p50_ms:s[Math.ceil(s.length*.5)-1],p95_ms:s[Math.ceil(s.length*.95)-1],max_ms:s.at(-1)};};
const score=rows=>({n:rows.length,hit1:rows.filter(r=>r.rank===1).length,hit3:rows.filter(r=>r.rank!==null&&r.rank<=3).length,mrr:rows.reduce((n,r)=>n+(r.rank===null?0:1/r.rank),0)/rows.length});
const memory=process.memoryUsage();
const report={status:'complete',mode,...config,node:process.version,transformers:'4.3.0',script_sha256:createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),fixture_sha256:createHash('sha256').update(bytes).digest('hex'),documents:documents.length,positive:score(results.filter(r=>r.relevant.length)),ordinary:score(results.filter(r=>r.group==='ordinary')),contrast:score(results.filter(r=>r.group==='contrast')),no_answer:results.filter(r=>r.group==='no_answer'),timing:{load_ms:loaded-start,first_inference_ms:cold.elapsed,passage:stats(times.passage),query:stats(times.query),long_input:longInput,total_ms:performance.now()-start},memory:{rss_bytes:memory.rss,peak_rss_bytes:process.resourceUsage().maxRSS*1024,heap_bytes:memory.heapUsed},cpu_microseconds:process.cpuUsage(),results};
await writeFile(outputPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});
const {results:_,no_answer:__,...summary}=report;console.log(JSON.stringify(summary));
await extractor.dispose();
