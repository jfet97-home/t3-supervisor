import { canResetActivity,guidanceScopeForSelection,guidanceScopeAfterClassification } from "../src/guidance-contract.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, get } from "node:http";
import { WebSocketServer } from "ws";
import { Effect } from "effect";
import { GuidanceStore } from "../src/guidance-store.js";
import { GuidanceRuntime, liveEvidence,makeGuidanceModel } from "../src/guidance.js";
import { readStructuredModelOutput } from "../src/recap.js";
import { dispatchGuidance } from "../src/guidance-native.js";
import { startGuidanceUi } from "../src/guidance-ui.js";
import { makeStore, Store } from "../src/store.js";
import type {
  GuidanceRuleInput,
  GuidanceSnapshot,
} from "../src/guidance-contract.js";
import type { T3ClientShape } from "../src/t3.js";
import type { Projection, SupervisorConfig } from "../src/types.js";

test("structured intent output is decoded independently of recap output",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"guidance-output-test-"));
  try{const path=join(directory,"output.json");const value={verdict:"match",evidenceIds:["main"],reason:"Current intent",phase:"same",objectId:null};
    await writeFile(path,JSON.stringify(value));assert.deepEqual(await readStructuredModelOutput(path),value);
    await writeFile(path,"x".repeat(9000));await assert.rejects(readStructuredModelOutput(path));
  }finally{await rm(directory,{recursive:true,force:true});}
});

test("live evidence includes main messages and command inputs, excluding children, reasoning and guidance",()=>{
  const run={id:"run",ordinal:1,status:"running",requestedAt:"2026-10-09T00:00:00Z",startedAt:null,completedAt:null,rootNodeId:"root",providerThreadId:"provider"};
  const root={id:"root",threadId:"thread",runId:"run",rootNodeId:"root",providerThreadId:"provider",kind:"root_turn",status:"running",parentNodeId:null};
  const main={...root,id:"main-node",kind:"assistant_message",parentNodeId:"root"};
  const child={...root,id:"child",kind:"subagent",parentNodeId:"root"};
  const childMessage={...main,id:"child-message",parentNodeId:"child"};
  const command={...main,id:"command-node",kind:"command_execution"};
  const reasoning={...main,id:"reasoning-node",kind:"reasoning"};
  const message=(id:string,nodeId:string)=>({id,nodeId,threadId:"thread",runId:"run",role:"assistant",text:"Current plan",streaming:true,createdAt:"2026-10-09T00:00:00Z",updatedAt:"2026-10-09T00:00:00Z"});
  const data:Projection={thread:{id:"thread",title:"Work",projectId:"project",lineage:{parentThreadId:null,relationshipToParent:null}},runs:[run],
    nodes:[root,main,child,childMessage,command,reasoning],messages:[message("main","main-node"),message("child-output","child-message"),message("hidden","reasoning-node"),message("supervisor-notice:opaque","main-node")],
    turnItems:[{id:"command",runId:"run",nodeId:"command-node",type:"command_execution",input:"gh pr ready",updatedAt:"2026-10-09T00:00:00Z"},{id:"thought",runId:"run",nodeId:"reasoning-node",type:"reasoning",input:"Private thought",updatedAt:"2026-10-09T00:00:00Z"}]};
  assert.deepEqual(liveEvidence(data,run).map(item=>item.id),["main","command"]);
});

test("distinct objects rearm only on an explicit new situation and resolution cannot erase uncertainty",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"guidance-object-test-"));const store=new GuidanceStore(directory);
  try{let rule=store.saveRule(newRule);rule=store.saveRule({...rule,expectedGeneration:rule.generation,mode:"send"});
    const first=store.commit(rule,store.settings().generation,"thread","run",Date.now(),"PR/1")!;store.start(first.id);store.finish(first.id,"accepted","message");
    assert.equal(store.commit(rule,store.settings().generation,"thread","run",Date.now(),"PR/2"),null);
    const next=store.commit(rule,store.settings().generation,"thread","run",Date.now(),"PR/2",true)!;assert.ok(next);store.start(next.id);store.finish(next.id,"uncertain",null);
    store.resolveEpisode("thread",rule.id);assert.equal(store.commit(rule,store.settings().generation,"thread","run",Date.now(),"PR/3",true),null);
  }finally{store.close();await rm(directory,{recursive:true,force:true});}
});

const newRule: GuidanceRuleInput = {
  id: null,
  expectedGeneration: 0,
  name: "Review",
  condition: "Agent plans publication",
  message: "Obtain independent review",
  scope: "global",
  projectId: null,
  mode: "observe",
};
const config = (directory: string): SupervisorConfig => ({
  dataDirectory: directory,
  t3Url: "http://127.0.0.1:3773",
  t3TokenFile: "unused",
  mcpxUrl: "unused",
  cxCommand: "unused",
  cxHome: directory,
  cxSeedFile: "unused",
  excludedThreadIds: [],
  healthPort: 0,
  modelTimeoutMs: 1000,
  uiPort: 0,
  uiHost: "127.0.0.1",
  uiAssetsDirectory: directory,
});
const projection: Projection = {
  thread: {
    id: "thread",
    title: "Work",
    projectId: "project",
    activeRunId: "run",
    lineage: { parentThreadId: null, relationshipToParent: null },
    createdAt: "2020-01-01T00:00:00Z",
  },
  runs: [
    {
      id: "run",
      ordinal: 1,
      status: "running",
      requestedAt: "2020-01-01T00:00:00Z",
      startedAt: null,
      completedAt: null,
      rootNodeId: "root",
    },
  ],
  messages: [],
};
const t3: T3ClientShape = {
  descriptor: () =>
    Effect.succeed({
      environmentId: "environment",
      serverVersion: "tested-build",
      orchestrationProtocolVersion: 2,
    }),
  projection: () => Effect.succeed({ snapshotSequence: 1, projection }),
  watch: () => Effect.never,
};

test("rule edits and mode-only saves preserve revisions and enforce compare-and-swap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "guidance-store-test-"));
  const store = new GuidanceStore(directory);
  try {
    const first = store.saveRule(newRule, 100);
    const sent = store.saveRule(
      { ...first, expectedGeneration: first.generation, mode: "send" },
      200,
    );
    assert.equal(sent.revision, 1);
    assert.equal(sent.mode, "send");
    const changed = store.saveRule(
      {
        ...sent,
        expectedGeneration: sent.generation,
        message: "Different guidance",
        mode: "send",
      },
      300,
    );
    assert.equal(changed.mode, "observe");
    assert.equal(changed.revision, 2);
    assert.throws(
      () => store.saveRule({ ...sent, expectedGeneration: sent.generation }),
      /another tab/,
    );
    assert.throws(
      () => store.saveRule({ ...newRule, condition: "   " }),
      /Complete/,
    );
    assert.equal(
      store.saveRule({ ...changed, expectedGeneration: changed.generation })
        .generation,
      changed.generation,
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("accepted episodes survive pause, mode changes and edits; uncertainty survives restart and blocks reset", async () => {
  const directory = await mkdtemp(join(tmpdir(), "guidance-episode-test-"));
  let store = new GuidanceStore(directory);
  try {
    let rule = store.saveRule(newRule);
    rule = store.saveRule({
      ...rule,
      expectedGeneration: rule.generation,
      mode: "send",
    });
    const notice = store.commit(
      rule,
      store.settings().generation,
      "thread",
      "run",
      Date.now(),
    )!;
    assert.ok(notice);
    assert.equal(store.start(notice.id), true);
    store.finish(notice.id, "accepted", "message");
    rule = store.saveRule({
      ...rule,
      expectedGeneration: rule.generation,
      mode: "paused",
    });
    rule = store.saveRule({
      ...rule,
      expectedGeneration: rule.generation,
      mode: "send",
    });
    assert.equal(
      store.commit(
        rule,
        store.settings().generation,
        "thread",
        "next-run",
        Date.now(),
      ),
      null,
    );
    store.reset("thread", rule.id);
    const uncertain = store.commit(
      rule,
      store.settings().generation,
      "thread",
      "next-run",
      Date.now(),
    )!;
    store.start(uncertain.id);
    store.close();
    store = new GuidanceStore(directory);
    assert.equal(
      store.notices().find((n) => n.id === uncertain.id)?.state,
      "uncertain",
    );
    assert.throws(() => store.reset("thread", rule.id), /uncertainty/);
    assert.equal(
      store.commit(
        rule,
        store.settings().generation,
        "thread",
        "next-run",
        Date.now(),
      ),
      null,
    );
    assert.ok(store.activities().some(a=>a.state==="uncertain" && a.noticeId===uncertain.id));
    store.reset("thread", rule.id, true,store.episode("thread",rule.id).epoch,uncertain.id);
    assert.ok(
      store.commit(
        rule,
        store.settings().generation,
        "thread",
        "fresh-run",
        Date.now(),
      ),
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("restart before dispatch marker is not uncertain and settings pause invalidates commitment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "guidance-restart-test-"));
  let store = new GuidanceStore(directory);
  try {
    let rule = store.saveRule(newRule);
    rule = store.saveRule({
      ...rule,
      expectedGeneration: rule.generation,
      mode: "send",
    });
    const prior = store.settings();
    store.saveSettings({ ...prior, guidancePaused: true });
    assert.equal(
      store.commit(rule, prior.generation, "thread", "run", Date.now()),
      null,
    );
    store.saveSettings({ ...store.settings(), guidancePaused: false });
    const notice = store.commit(
      rule,
      store.settings().generation,
      "thread",
      "run",
      Date.now(),
    )!;
    store.close();
    store = new GuidanceStore(directory);
    assert.equal(
      store.db.prepare("SELECT state FROM notices WHERE id=?").get(notice.id)
        ?.state,
      "not_delivered_restart",
    );
    assert.ok(
      store.commit(
        rule,
        store.settings().generation,
        "thread",
        "fresh-run",
        Date.now(),
      ),
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("local UI opens without login while enforcing host, origin, CSRF and stale-tab checks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "guidance-ui-test-"));
  const guidance = new GuidanceStore(directory);
  await writeFile(
    join(directory, "index.html"),
    '<html><script src="/app.js"></script></html>',
  );
  await writeFile(join(directory, "ui-login-code"), "retired-test-code");
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const source = yield* Store;
        const runtime = new GuidanceRuntime(
          config(directory),
          guidance,
          source,
          t3,
          {
            decide: async () => ({
              verdict: "needs_context",
              evidenceIds: [],
              reason: "fixture",
              phase: "same",
              objectId: null,
            }),
          },
        );
        runtime.descriptor = {
          environmentId: "environment",
          serverVersion: "tested-build",
          orchestrationProtocolVersion: 2,
        };
        runtime.connected = true;
        const ui = yield* Effect.promise(() =>
          startGuidanceUi(config(directory), runtime),
        );
        yield* Effect.promise(async () => {
          try {
            const address = ui.server.address();
            assert.ok(address && typeof address === "object");
            const origin = `http://127.0.0.1:${address.port}`;
            const browserStatus = (path: string, headers: Record<string, string>) =>
              new Promise<number>((resolve, reject) => {
                get(origin + path, { headers }, response => {
                  response.resume();
                  resolve(response.statusCode ?? 0);
                }).on("error", reject);
              });
            const root = await fetch(origin);
            assert.equal(root.status, 200);
            assert.match(
              root.headers.get("content-security-policy")!,
              /frame-ancestors 'none'/,
            );
            assert.match(await root.text(), /nonce=/);
            await assert.rejects(readFile(join(directory, "ui-login-code")), { code: "ENOENT" });
            const navigation = {
              "Sec-Fetch-Site": "cross-site",
              "Sec-Fetch-Mode": "navigate",
              "Sec-Fetch-Dest": "document",
              "Sec-Fetch-User": "?1",
            };
            assert.equal(await browserStatus("/", navigation), 200);
            assert.equal(await browserStatus("/index.html", navigation), 200);
            assert.equal(await browserStatus("/", { ...navigation, "Sec-Fetch-Dest": "iframe" }), 403);
            assert.equal(await browserStatus("/", { ...navigation, "Sec-Fetch-User": "?0" }), 403);
            assert.equal(await browserStatus("/", { Host: "attacker.invalid" }), 403);
            assert.equal(await browserStatus("/api/guidance/snapshot", navigation), 403);
            assert.equal(await browserStatus("/api/csrf", navigation), 403);
            assert.equal(
              (await fetch(origin + "/api/guidance/snapshot")).status,
              200,
            );
            assert.equal(
              (
                await fetch(origin + "/api/csrf", {
                  headers: {
                    Origin: "http://attacker.invalid",
                  },
                })
              ).status,
              403,
            );
            const access = await fetch(origin + "/api/csrf");
            assert.equal(access.status, 200);
            assert.match(access.headers.get("set-cookie")!, /Max-Age=0/);
            const session: unknown = await access.json();
            assert.ok(
              typeof session === "object" &&
                session !== null &&
                "csrf" in session &&
                typeof session.csrf === "string",
            );
            const headers = {
              Origin: origin,
              "Content-Type": "application/json",
              "x-csrf-token": session.csrf,
            };
            assert.equal((await fetch(origin + "/api/login", { method: "POST", headers, body: "{}" })).status, 404);
            assert.equal((await fetch(origin + "/api/guidance/rules", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(newRule) })).status, 403);
            assert.equal((await fetch(origin + "/api/guidance/rules", { method: "POST", headers: { ...headers, Origin: "http://attacker.invalid" }, body: JSON.stringify(newRule) })).status, 403);
            assert.equal(
              (
                await fetch(origin + "/api/guidance/rules", {
                  method: "POST",
                  headers: { ...headers, "x-csrf-token": "wrong" },
                  body: JSON.stringify(newRule),
                })
              ).status,
              403,
            );
            const response = await fetch(origin + "/api/guidance/rules", {
              method: "POST",
              headers,
              body: JSON.stringify(newRule),
            });
            assert.equal(response.status, 200);
            const saved = guidance.rules()[0]!;
            const update = {
              ...saved,
              expectedGeneration: saved.generation,
              mode: "send",
            };
            assert.equal(
              (
                await fetch(origin + "/api/guidance/rules", {
                  method: "POST",
                  headers,
                  body: JSON.stringify(update),
                })
              ).status,
              200,
            );
            assert.equal(
              (
                await fetch(origin + "/api/guidance/rules", {
                  method: "POST",
                  headers,
                  body: JSON.stringify(update),
                })
              ).status,
              400,
            );
            const snapshotResponse = await fetch(
              origin + "/api/guidance/snapshot",
            );
            assert.equal(snapshotResponse.status, 200);
            const snapshot =
              (await snapshotResponse.json()) as GuidanceSnapshot;
            assert.equal(snapshot.rules.length, 1);
            assert.equal(snapshot.sendingReady, false);
            assert.equal(
              (
                await fetch(origin + "/api/guidance/settings", {
                  method: "POST",
                  headers,
                  body: JSON.stringify({
                    ...snapshot.settings,
                    allowFollowupRace: true,
                    verifiedServerVersion: "wrong",
                  }),
                })
              ).status,
              400,
            );
            guidance.saveSettings({...guidance.settings(),allowFollowupRace:true,verifiedServerVersion:"tested-build"});
            runtime.descriptor=null;
            assert.equal((await fetch(origin+"/api/guidance/settings",{method:"POST",headers,body:JSON.stringify({...guidance.settings(),guidancePaused:true})})).status,200);
            assert.equal(guidance.settings().guidancePaused,true);
            assert.equal((await fetch(origin+"/api/guidance/settings",{method:"POST",headers,body:JSON.stringify({...guidance.settings(),verifiedServerVersion:"different-build"})})).status,400);
            const older=guidance.record({kind:"guidance",threadId:"thread",ruleId:saved.id,runId:"run",noticeId:null,episodeEpoch:0,state:"needs_context",reason:"fixture",detail:null});
            guidance.reset("thread",saved.id,false,0);
            assert.equal((await fetch(origin+"/api/guidance/action",{method:"POST",headers,body:JSON.stringify({id:older.id,action:"reset",noticeId:null,expectedEpoch:1})})).status,400);
            assert.equal(guidance.episode("thread",saved.id).epoch,1);
            const fresh=guidance.record({kind:"guidance",threadId:"thread",ruleId:saved.id,runId:"run",noticeId:null,episodeEpoch:1,state:"needs_context",reason:"fixture",detail:null});
            assert.equal((await fetch(origin+"/api/guidance/action",{method:"POST",headers,body:JSON.stringify({id:fresh.id,action:"reset",noticeId:null,expectedEpoch:1})})).status,200);
            assert.equal((await fetch(origin+"/api/guidance/action",{method:"POST",headers,body:JSON.stringify({id:fresh.id,action:"feedback_wrong",noticeId:null,expectedEpoch:1})})).status,200);
            const ownerAction=guidance.activities().find(row=>row.kind==="owner_action")!;
            assert.equal(canResetActivity(ownerAction),false);
            assert.equal(canResetActivity(fresh),true);
          } finally {
            await ui.close();
          }
        });
      }).pipe(Effect.provide(makeStore(directory)), Effect.scoped),
    );
  } finally {
    guidance.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("native adapter uses stable targeted message.dispatch, never an answer or deliveryIntent fallback", async () => {
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  let payload: Record<string, unknown> | undefined;
  sockets.on("connection", (socket) =>
    socket.on("message", (data) => {
      const value = JSON.parse(data.toString()) as {
        payload: Record<string, unknown>;
      };
      payload = value.payload;
      socket.send(
        JSON.stringify({
          _tag: "Exit",
          requestId: "guidance",
          exit: { _tag: "Success", value: { sequence: 42 } },
        }),
      );
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const receipt = await dispatchGuidance({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "test-credential",
      threadId: "thread",
      runId: "run",
      noticeId: "unique",
      text: "Saved text",
      beforeDispatch: () => true,
      signal: AbortSignal.timeout(1000),
    });
    assert.equal(receipt.outcome, "accepted");
    assert.equal(receipt.messageId, "supervisor-notice:unique");
    assert.equal(payload?.type, "message.dispatch");
    assert.deepEqual(payload?.dispatchMode, {
      type: "steer_active",
      targetRunId: "run",
    });
    assert.equal(payload?.deliveryIntent, undefined);
    assert.equal(payload?.answers, undefined);
    assert.equal(payload?.commandId, "supervisor-guidance:unique");
  } finally {
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a paused or edited rule cancels a committed notice before its dispatch marker",async()=>{
 const directory=await mkdtemp(join(tmpdir(),"guidance-preflight-test-"));const store=new GuidanceStore(directory);
 try{
  let rule=store.saveRule(newRule);rule=store.saveRule({...rule,expectedGeneration:rule.generation,mode:"send"});
  const first=store.commit(rule,store.settings().generation,"thread","run",Date.now())!;
  store.saveSettings({...store.settings(),guidancePaused:true});assert.equal(store.start(first.id),false);
  assert.equal(store.db.prepare("SELECT dispatch_started FROM notices WHERE id=?").get(first.id)?.dispatch_started,0);
  store.finish(first.id,"rejected",null);store.saveSettings({...store.settings(),guidancePaused:false});
  const second=store.commit(rule,store.settings().generation,"thread","run",Date.now())!;
  store.saveRule({...rule,expectedGeneration:rule.generation,message:"Updated instruction"});assert.equal(store.start(second.id),false);
 }finally{store.close();await rm(directory,{recursive:true,force:true});}
});

test("late receipt for an old epoch cannot suppress a reset episode",async()=>{
 const directory=await mkdtemp(join(tmpdir(),"guidance-epoch-test-"));const store=new GuidanceStore(directory);
 try{
  let rule=store.saveRule(newRule);rule=store.saveRule({...rule,expectedGeneration:rule.generation,mode:"send"});
  const first=store.commit(rule,store.settings().generation,"thread","run",Date.now())!;store.start(first.id);store.finish(first.id,"accepted","message");
  store.reset("thread",rule.id,false,0);store.reconcile(first.id);
  assert.ok(store.commit(rule,store.settings().generation,"thread","run",Date.now()));
 }finally{store.close();await rm(directory,{recursive:true,force:true});}
});

test("stale owner acceptance cannot clear a newer uncertain notice",async()=>{
 const directory=await mkdtemp(join(tmpdir(),"guidance-stale-owner-test-"));const store=new GuidanceStore(directory);
 try{
  let rule=store.saveRule(newRule);rule=store.saveRule({...rule,expectedGeneration:rule.generation,mode:"send"});
  const first=store.commit(rule,store.settings().generation,"thread","run",Date.now())!;store.start(first.id);store.finish(first.id,"uncertain",null);
  store.reset("thread",rule.id,true,0,first.id);
  const second=store.commit(rule,store.settings().generation,"thread","run",Date.now())!;store.start(second.id);store.finish(second.id,"uncertain",null);
  assert.throws(()=>store.reset("thread",rule.id,true,0,first.id),/episode changed/);
  assert.throws(()=>store.reset("thread",rule.id,true,1,first.id),/notice changed/);
  assert.equal(store.notices().find(n=>n.id===second.id)?.state,"uncertain");
 }finally{store.close();await rm(directory,{recursive:true,force:true});}
});

test("restart invalidates consent for another build and bounded reconciliation reaches the sixth notice",async()=>{
 const directory=await mkdtemp(join(tmpdir(),"guidance-fair-recovery-test-"));const store=new GuidanceStore(directory);
 try{
  let rule=store.saveRule(newRule);rule=store.saveRule({...rule,expectedGeneration:rule.generation,mode:"send"});
  for(let i=0;i<6;i++){const notice=store.commit(rule,store.settings().generation,`thread-${i}`,"run",Date.now())!;store.start(notice.id);store.finish(notice.id,"uncertain",null);}
  const target=store.notices().at(-1)!;
  store.saveSettings({...store.settings(),allowFollowupRace:true,verifiedServerVersion:"older-build"});
  await Effect.runPromise(Effect.gen(function*(){
   const source=yield* Store;
   const runtime=new GuidanceRuntime(config(directory),store,source,{...t3,projection:(id)=>Effect.succeed({snapshotSequence:1,projection:{...projection,thread:{...projection.thread,id},messages:id===target.threadId?[{id:`supervisor-notice:${target.id}`,nodeId:null,runId:"run",role:"user",text:target.text,streaming:false,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}]:[]}})}, {decide:async()=>{throw new Error("No active threads");}});
   yield* Effect.promise(async()=>{await runtime.runOnce(new AbortController().signal);assert.equal(store.settings().allowFollowupRace,false);assert.equal(store.settings().verifiedServerVersion,null);assert.ok(store.notices().some(n=>n.id===target.id));await runtime.runOnce(new AbortController().signal);assert.equal(store.notices().some(n=>n.id===target.id),false);});
  }).pipe(Effect.provide(makeStore(join(directory,"source"))),Effect.scoped));
 }finally{store.close();await rm(directory,{recursive:true,force:true});}
});

test("a resolution corrected during inference cannot reset the accepted episode",async()=>{
 const directory=await mkdtemp(join(tmpdir(),"guidance-resolution-test-"));const store=new GuidanceStore(directory);
 try{
  let rule=store.saveRule(newRule);rule=store.saveRule({...rule,expectedGeneration:rule.generation,mode:"send"});
  const notice=store.commit(rule,store.settings().generation,"thread","run",Date.now())!;store.start(notice.id);store.finish(notice.id,"accepted","message");
  let text="I cancel publication";let stamp="";let calls=0;
  await Effect.runPromise(Effect.gen(function*(){
   const source=yield* Store;
   const root={id:"root",threadId:"thread",runId:"run",rootNodeId:"root",parentNodeId:null,kind:"root_turn",status:"running"};
   const current=():Projection=>({...projection,runtimeRequests:[],nodes:[root,{...root,id:"main",parentNodeId:"root",kind:"assistant_message"}],messages:[{id:"anchor",threadId:"thread",nodeId:"main",runId:"run",role:"assistant",text,streaming:true,createdAt:stamp,updatedAt:stamp}]});
   const runtime=new GuidanceRuntime(config(directory),store,{...source,catalog:()=>Effect.succeed({projects:[{project:{id:"project",title:"Project",workspaceRoot:"/workspace"},available:true}],threads:[projection.thread]})},{...t3,projection:()=>Effect.succeed({snapshotSequence:1,projection:current()})},{decide:async()=>{calls++;text="I continue the same publication";return {verdict:"no_match",evidenceIds:["anchor"],reason:"Resolution",phase:"resolved",objectId:null};}});
   stamp=new Date(runtime.startedAt).toISOString();
   yield* Effect.promise(()=>runtime.runOnce(new AbortController().signal));
   assert.equal(calls,1);
   assert.equal(store.episode("thread",rule.id).epoch,0);
  }).pipe(Effect.provide(makeStore(join(directory,"source"))),Effect.scoped));
 }finally{store.close();await rm(directory,{recursive:true,force:true});}
});

test("native adapter sends no command when post-connect validation is cancelled",async()=>{
 const server=createServer();const sockets=new WebSocketServer({server});let commands=0;
 sockets.on("connection",socket=>socket.on("message",()=>{commands++;}));
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 const address=server.address();assert.ok(address && typeof address==="object");
 const controller=new AbortController();let release:(value:boolean)=>void=()=>{};
 let entered:()=>void=()=>{};const pending=new Promise<void>(resolve=>{entered=resolve;});
 const validation=new Promise<boolean>(resolve=>{release=resolve;});
 try{
  const dispatch=dispatchGuidance({baseUrl:`http://127.0.0.1:${address.port}`,token:"fixture",threadId:"thread",runId:"run",noticeId:"fixture",text:"Guidance",signal:controller.signal,beforeDispatch:()=>{entered();return validation;}});
  await pending;controller.abort();assert.equal((await dispatch).outcome,"rejected");release(true);
  await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(commands,0);
 }finally{for(const socket of sockets.clients)socket.terminate();await new Promise<void>(resolve=>sockets.close(()=>resolve()));await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test("uncertain notices remain actionable after activity pagination and retention",async()=>{
 const directory=await mkdtemp(join(tmpdir(),"guidance-retention-test-"));const store=new GuidanceStore(directory);
 try{
  let rule=store.saveRule(newRule);rule=store.saveRule({...rule,expectedGeneration:rule.generation,mode:"send"});
  const notice=store.commit(rule,store.settings().generation,"thread","run",1)!;store.start(notice.id);store.finish(notice.id,"uncertain",null);
  for(let n=0;n<210;n++)store.record({kind:"guidance",threadId:`other-${n}`,ruleId:rule.id,runId:"run",noticeId:null,episodeEpoch:0,state:"observe_only",reason:"fixture",detail:null},n+2);
  store.prune(Date.now());
  const actionable=store.activities().find(a=>a.noticeId===notice.id);assert.equal(actionable?.state,"uncertain");assert.equal(actionable?.episodeEpoch,0);
  store.reset("thread",rule.id,true,actionable!.episodeEpoch!,actionable!.noticeId!);
  assert.equal(store.activities().some(a=>a.id===actionable!.id),false);
 }finally{store.close();await rm(directory,{recursive:true,force:true});}
});

test("an oversized escaped prompt consumes no monitoring budget",async()=>{
 const directory=await mkdtemp(join(tmpdir(),"guidance-context-budget-test-"));const store=new GuidanceStore(directory);
 try{
  const model=makeGuidanceModel(config(directory),store);
  await assert.rejects(model.decide("x".repeat(8000),"\"".repeat(24000),["fixture"],new AbortController().signal),/monitor_context_limit/);
  assert.equal(store.used(),0);
 }finally{store.close();await rm(directory,{recursive:true,force:true});}
});

test("a native failure after dispatch stays uncertain rather than permitting a duplicate",async()=>{
 const server=createServer();const sockets=new WebSocketServer({server});
 sockets.on("connection",socket=>socket.on("message",()=>socket.send(JSON.stringify({_tag:"Exit",requestId:"guidance",exit:{_tag:"Failure",cause:[{_tag:"Die",defect:"fixture"}]}}))));
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();assert.ok(address && typeof address==="object");
 try{assert.equal((await dispatchGuidance({baseUrl:`http://127.0.0.1:${address.port}`,token:"fixture",threadId:"thread",runId:"run",noticeId:"notice",text:"Exact guidance",beforeDispatch:()=>true,signal:new AbortController().signal})).outcome,"uncertain");}
 finally{for(const socket of sockets.clients)socket.terminate();await new Promise<void>(resolve=>sockets.close(()=>resolve()));await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test("late readback activity retains the old notice identity and cannot reset a newer episode",async()=>{
 const directory=await mkdtemp(join(tmpdir(),"guidance-receipt-identity-test-"));const store=new GuidanceStore(directory);
 try{
  let rule=store.saveRule(newRule);rule=store.saveRule({...rule,expectedGeneration:rule.generation,mode:"send"});
  const old=store.commit(rule,store.settings().generation,"thread","run",Date.now())!;store.start(old.id);store.finish(old.id,"uncertain",null);store.reset("thread",rule.id,true,0,old.id);
  assert.equal(store.commit(rule,store.settings().generation,"thread","run",Date.now(),null,false,0),null);
  const latest=store.commit(rule,store.settings().generation,"thread","run",Date.now())!;store.start(latest.id);store.finish(latest.id,"accepted","message");
  await Effect.runPromise(Effect.gen(function*(){
   const source=yield* Store;
   const runtime=new GuidanceRuntime(config(directory),store,source,{...t3,projection:()=>Effect.succeed({snapshotSequence:1,projection:{...projection,messages:[{id:`supervisor-notice:${old.id}`,nodeId:null,runId:"run",role:"user",text:old.text,streaming:false,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}]}})},{decide:async()=>{throw new Error("No active threads");}});
   yield* Effect.promise(()=>runtime.runOnce(new AbortController().signal));
  }).pipe(Effect.provide(makeStore(join(directory,"source"))),Effect.scoped));
  const activity=store.activities().find(a=>a.state==="visible" && a.noticeId===old.id)!;assert.ok(activity);assert.equal(activity.episodeEpoch,0);
  assert.throws(()=>store.reset("thread",rule.id,false,activity.episodeEpoch,activity.noticeId),/episode changed/);
  assert.equal(store.episode("thread",rule.id).epoch,1);
 }finally{store.close();await rm(directory,{recursive:true,force:true});}
});

test("durable uncertainty cards preserve available evidence outside the recent activity page",async()=>{
 const directory=await mkdtemp(join(tmpdir(),"guidance-uncertain-evidence-test-"));const store=new GuidanceStore(directory);
 try{
  let rule=store.saveRule(newRule);rule=store.saveRule({...rule,expectedGeneration:rule.generation,mode:"send"});
  const notice=store.commit(rule,store.settings().generation,"thread","run",Date.now())!;store.start(notice.id);store.finish(notice.id,"uncertain",null);
  store.record({kind:"guidance",threadId:"thread",ruleId:rule.id,runId:"run",noticeId:notice.id,episodeEpoch:notice.epoch,state:"in_flight",reason:"committed",detail:"Safe retained evidence"});
  for(let n=0;n<210;n++)store.record({kind:"guidance",threadId:`other-${n}`,ruleId:rule.id,runId:"run",noticeId:null,episodeEpoch:0,state:"observe_only",reason:"fixture",detail:null},Date.now()+n+1);
  assert.equal(store.activities().find(a=>a.id===`notice:${notice.id}`)?.detail,"Safe retained evidence");
 }finally{store.close();await rm(directory,{recursive:true,force:true});}
});

test("failed inference retains its originating epoch after an owner reset",async()=>{
 const directory=await mkdtemp(join(tmpdir(),"guidance-failed-inference-epoch-test-"));const store=new GuidanceStore(directory);
 try{
  let rule=store.saveRule(newRule);rule=store.saveRule({...rule,expectedGeneration:rule.generation,mode:"send"});
  const first=store.commit(rule,store.settings().generation,"thread","run",Date.now())!;store.start(first.id);store.finish(first.id,"accepted","message");
  let calls=0;
  await Effect.runPromise(Effect.gen(function*(){
   const source=yield* Store;const root={id:"root",threadId:"thread",runId:"run",rootNodeId:"root",parentNodeId:null,kind:"root_turn",status:"running"};
   const runtime=new GuidanceRuntime(config(directory),store,{...source,catalog:()=>Effect.succeed({projects:[{project:{id:"project",title:"Project",workspaceRoot:"/workspace"},available:true}],threads:[projection.thread]})},{...t3,projection:()=>Effect.succeed({snapshotSequence:1,projection:{...projection,nodes:[root,{...root,id:"main",parentNodeId:"root",kind:"assistant_message"}],messages:[{id:"anchor",threadId:"thread",nodeId:"main",runId:"run",role:"assistant",text:"Current plan",streaming:true,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}]}})},{decide:async()=>{calls++;store.reset("thread",rule.id,false,0);throw new Error("Fixture inference failure");}});
   yield* Effect.promise(()=>runtime.runOnce(new AbortController().signal));
  }).pipe(Effect.provide(makeStore(join(directory,"source"))),Effect.scoped));
  assert.equal(calls,1);
  const row=store.activities().find(a=>a.state==="model_unavailable")!;assert.equal(row.episodeEpoch,0);assert.equal(row.noticeId,null);
  const next=store.commit(rule,store.settings().generation,"thread","run",Date.now())!;store.start(next.id);store.finish(next.id,"accepted","next-message");
  assert.throws(()=>store.reset("thread",rule.id,false,row.episodeEpoch,row.noticeId),/episode changed/);
  assert.equal(store.episode("thread",rule.id).epoch,1);
 }finally{store.close();await rm(directory,{recursive:true,force:true});}
});

test("a synchronized classification change normalizes the selected project to no-project scope",async()=>{
 const directory=await mkdtemp(join(tmpdir(),"guidance-scope-transition-test-"));const store=new GuidanceStore(directory);
 try{
  await Effect.runPromise(Effect.gen(function*(){
   const source=yield* Store;
   const runtime=new GuidanceRuntime(config(directory),store,{...source,catalog:()=>Effect.succeed({projects:[{project:{id:"project",title:"Project",workspaceRoot:"/workspace"},available:true}],threads:[]})},t3,{decide:async()=>{throw new Error("No active threads");}});
   yield* Effect.promise(async()=>{
    const before=await runtime.snapshot();assert.equal(guidanceScopeForSelection("project",before.projects),"project");
    store.classify("project","scratch",store.settings().generation);
    const after=await runtime.snapshot();assert.equal(guidanceScopeForSelection("project",after.projects),"scratch");
    assert.equal(guidanceScopeForSelection("global",after.projects),"global");assert.equal(guidanceScopeForSelection("scratch",after.projects),"scratch");
   });
  }).pipe(Effect.provide(makeStore(join(directory,"source"))),Effect.scoped));
 }finally{store.close();await rm(directory,{recursive:true,force:true});}
});

test("a delayed classification completion preserves the owner's newer scope selection",async()=>{
 let selected="project-a";let complete:()=>void=()=>{};
 const pending=new Promise<void>(resolve=>{complete=resolve;});
 const applying=pending.then(()=>{selected=guidanceScopeAfterClassification(selected,"project-a");});
 selected="project-b";complete();await applying;assert.equal(selected,"project-b");
 assert.equal(guidanceScopeAfterClassification("project-a","project-a"),"scratch");
 assert.equal(guidanceScopeAfterClassification("global","project-a"),"global");
});
