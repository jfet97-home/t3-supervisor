import { Effect,Layer } from "effect";
import { readFile,mkdtemp,rm,writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NodeRuntime } from "@effect/platform-node";
import { loadConfig } from "../src/config.js";
import { makeStore,Store } from "../src/store.js";
import { makeT3Client,T3Client } from "../src/t3.js";
import { GuidanceStore } from "../src/guidance-store.js";
import { GuidanceRuntime } from "../src/guidance.js";
import { startGuidanceUi } from "../src/guidance-ui.js";

const directory=await mkdtemp(join(tmpdir(),"guidance-ui-probe-"));
const token=(await readFile('/Users/andreasimonecosta/.config/mcpx/t3-supervisor-secrets/t3-read-token',"utf8")).trim();
const config={...loadConfig(),dataDirectory:directory,t3Url:"http://127.0.0.1:3773",uiPort:19008,uiHost:"127.0.0.1",uiAssetsDirectory:join(process.cwd(),"ui-dist"),guidanceTokenFile:join(directory,"absent-guidance-token"),managedScratchRoot:"/Users/andreasimonecosta/.t3/scratch"};
NodeRuntime.runMain(Effect.gen(function*(){
  const source=yield* Store;const t3=yield* T3Client;const descriptor=yield* t3.descriptor();yield* source.activate(descriptor.environmentId,Date.now());
  const store=yield* Effect.acquireRelease(Effect.sync(()=>new GuidanceStore(directory)),store=>Effect.sync(()=>store.close()));
  store.saveRule({id:null,expectedGeneration:0,name:"Review before publishing",condition:"The main agent intends to publish a non-draft PR.",message:"Obtain the independent review before publication.",scope:"global",projectId:null,mode:"paused"});
  const runtime=new GuidanceRuntime(config,store,source,t3,{decide:async()=>({verdict:"needs_context",phase:"same",objectId:null,evidenceIds:[],reason:"Isolated UI probe: model not invoked."})});
  const ui=yield* Effect.acquireRelease(Effect.promise(()=>startGuidanceUi(config,runtime)),ui=>Effect.promise(()=>ui.close()));
  // this fixed test code belongs only to the temporary, write-disabled probe
  yield* Effect.promise(()=>writeFile(join(directory,"ui-login-code"),"test-owner-code",{mode:0o600}));
  yield* Effect.forkScoped(t3.watch(undefined,item=>source.ingest(item)));
  yield* Effect.forkScoped(Effect.forever(Effect.promise(()=>runtime.runOnce(AbortSignal.timeout(30_000))).pipe(Effect.andThen(Effect.sleep("5 seconds")))));
  console.log(JSON.stringify({url:"http://127.0.0.1:19008",nativeWrites:false,telegramWrites:false,fixtureDetector:true,port:typeof ui.server.address()==="object"?19008:null}));
  yield* Effect.never;
}).pipe(Effect.provide(Layer.mergeAll(makeStore(directory),makeT3Client({baseUrl:config.t3Url,token}))),Effect.scoped,Effect.ensuring(Effect.promise(()=>rm(directory,{recursive:true,force:true})))));
