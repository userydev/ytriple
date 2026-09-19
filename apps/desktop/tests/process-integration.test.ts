import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Store } from "../src/core/store";
import { Runtime } from "../src/core/runtime";
import { ProcessRecords } from "../src/core/process";
import { Outcomes } from "../src/core/outcomes";
import { buildExchangeHistory, resolveRunContext } from "../src/core/workspace-exchange";
import { buildTaskInputManifest } from "../src/core/input-manifest";
import { processSnapshotStaleData } from "../src/core/process-scope-stale";
import { validateWorkspace } from "../src/core/workspace-backup";
import { teamResponse } from "../src/core/team-response";
import type { Contribution, Run, SubmitInput } from "../src/core/types";
import type { Model, Prompt, StreamEvent } from "../src/core/ycore";
const request = (extra: Partial<SubmitInput> = {}): SubmitInput => ({ key: randomUUID(), context: "new", text: "保留待验证约束", refs: [], recipient: null, projectId: null, ...extra });
const setup = () => { const s = new Store(":memory:"); s.initializeConfiguration(); return s; };
class Mock implements Model {
  calls: Prompt[] = [];
  constructor(readonly output: (p: Prompt) => string) {}
  async *stream(p: Prompt, key: string): AsyncGenerator<StreamEvent> { this.calls.push(p); yield { type: "run.started", run_id:key }; yield { type:"text.delta", run_id:key, text:this.output(p) }; yield { type:"run.completed", run_id:key }; }
}
test("actual runtime supplies source IDs, filters forged feedback, separates dialogue and evidence, and backup validates provenance", async () => {
  const s = setup();
  try {
    const model = new Mock(p => {
      const c = s.require<Contribution>("contribution", p.taskId);
      assert.ok(p.messages[1].content.includes(`msg:${c.runId}`));
      return teamResponse("简明结论", {body:"独立成果", baseVersionId:null}, {basis:"公开依据", feedback:[{sourceId:`msg:${c.runId}`,stance:"used"},{sourceId:"msg:foreign",stance:"used"}]});
    });
    const runtime = new Runtime(s, () => model);
    const submission = request(); const r = runtime.submit(submission); await runtime.settled(r.workId);
    assert.equal(s.require<Run>("run", r.id).status,"succeeded");
    const c=s.snapshot().contributions.at(-1)!;
    assert.equal(c.publicProcess?.feedback?.length,1);
    assert.ok(c.publicProcessWarnings?.[0].includes("foreign"));
    assert.equal(s.snapshot().messages.at(-1)!.body,"简明结论");
    assert.equal(s.snapshot().versions[0].body,"独立成果");
    const data=s.exportState(); validateWorkspace(data);
    const fresh=new Store(":memory:"); fresh.restoreState(data);
    assert.deepEqual(fresh.snapshot().inputManifests,s.snapshot().inputManifests); fresh.close();
    const corrupt=structuredClone(data); const m=corrupt.entities.find(e=>e.kind==="input-manifest")!;
    m.data=JSON.stringify({...JSON.parse(m.data),workId:randomUUID()});
    assert.throws(()=>validateWorkspace(corrupt),/归属/);
    runtime.submit(submission); await runtime.settled(r.workId);
    assert.equal(model.calls.length,1);
  } finally {s.close();}
});
test("child task cannot attribute root feedback; partial and unreadable materials never claim full delivery",async()=>{
  const s=setup();
  try {
    const material=s.addMaterial("限定材料","x".repeat(4000));
    const ref={materialId:material.id,version:1,label:material.title};
    const model=new Mock(p=>{
      const c=s.require<Contribution>("contribution",p.taskId);
      if((c.task?.depth??0)>0) return "子任务只分析分配的材料预览。";
      if(c.task?.returnedFrom) return teamResponse("已检查回信",null);
      return JSON.stringify({ytriple_delegate:{memberId:"researcher",objective:"仅检查所选材料",context:"不继承其他用户历史",references:[1]}});
    });
    const rt=new Runtime(s,()=>model); const r=rt.submit(request({refs:[ref]})); await rt.settled(r.workId);
    assert.equal(s.require<Run>("run",r.id).status,"succeeded");
    const child=s.snapshot().contributions.find(c=>(c.task?.depth??0)>0)!;
    const manifest=s.snapshot().inputManifests.find(m=>m.id===child.inputManifestId)!;
    assert.equal(manifest.entries.some(e=>e.kind==="message"),false);
    assert.equal(manifest.entries[0].coverage,"truncated");
    assert.ok(!model.calls.find(p=>p.taskId===child.id)!.messages[1].content.includes(`msg:${r.id}`));
    const root=s.snapshot().inputManifests.find(m=>m.contributionId===s.snapshot().contributions[0].id)!;
    assert.equal(root.entries.find(e=>e.kind==="material")!.coverage,"full");
  } finally{s.close();}
});
test("exchange source coverage is built with text, frozen across edits, and excludes fully trimmed background",()=>{
  const s=setup();
  try {
    const first=s.submit(request()); s.setRun(first.id,{status:"succeeded"});
    for(let n=0;n<20;n++) { const r=s.submit(request({context:first.workId,text:`历史-${n}-`+"字".repeat(700)})); s.setRun(r.id,{status:"succeeded"}); }
    const r=s.submit(request({context:first.workId}));
    const exchange=buildExchangeHistory(s,r);
    assert.ok(exchange.sources.some(e=>e.coverage==="summary"));
    for(const e of exchange.sources) {
      const prior=s.require<Run>("run",e.entityId);
      assert.ok(exchange.text.includes(prior.text.slice(0,e.coverage==="full"?prior.text.length:400)));
    }
    resolveRunContext(s,r,undefined);
    const before=buildTaskInputManifest(s,r,"first",[]).entries;
    const prior=s.require<Run>("run",exchange.sources[0].entityId); s.setRun(prior.id,{text:"后改历史不得改变已冻结来源"});
    const after=buildTaskInputManifest(s,r,"next",[]).entries;
    assert.deepEqual(after,before);
  }finally{s.close();}
});
test("frozen review distinguishes new feedback from changed original evidence and has no self-generated staleness",async()=>{
  const s=setup();
  try{
    const model=new Mock(()=>teamResponse("完成",{body:"主成果",baseVersionId:null})); const rt=new Runtime(s,()=>model);
    const r=rt.submit(request()); await rt.settled(r.workId);
    const version=s.snapshot().versions[0]; const outcomes=new Outcomes(s);
    const input={key:randomUUID(),versionId:version.id,kind:"usage" as const,recipient:"测试用户",purpose:"试用",occurredOn:"2026-09-19",body:"首次反馈",refs:[]};
    const first=outcomes.record(input);
    const draft=new ProcessRecords(s).prepare({workId:r.workId,mode:"review"}); const material=s.material(draft.refs.at(-1)!);
    const review=s.submit(request({...draft,context:r.workId,outputMode:"review"}));
    assert.equal(processSnapshotStaleData(material,s.snapshot()).status,"current");
    outcomes.record({...input,key:randomUUID(),body:"后续新反馈"});
    assert.equal(processSnapshotStaleData(material,s.snapshot()).status,"uncovered");
    const manifest=buildTaskInputManifest(s,review,"probe",draft.refs);
    assert.deepEqual(manifest.entries.filter(e=>e.kind==="outcome").map(e=>e.entityId),[first.id]);
    outcomes.withdraw(first.id,"修正记录");
    assert.equal(processSnapshotStaleData(material,s.snapshot()).status,"superseded");
  }finally{s.close();}
});
