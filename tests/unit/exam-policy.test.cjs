const test = require('node:test');
const assert = require('node:assert/strict');
const { examPolicy } = require('../../apps/api/dist/exam-policy');
test('Prüfungsregel: sichere Standardwerte und nur begrenzte positive Ganzzahlen', () => {
  assert.deepEqual(examPolicy({}), {maxFailures:3, windowMs:86400000, minWorkMs:20000});
  assert.deepEqual(examPolicy({EXAM_MAX_FAILURES:'4', EXAM_FAILURE_WINDOW_SECONDS:'30', EXAM_MIN_WORK_SECONDS:'5'}),
    {maxFailures:4, windowMs:30000, minWorkMs:5000});
  for(const name of ['EXAM_MAX_FAILURES','EXAM_FAILURE_WINDOW_SECONDS','EXAM_MIN_WORK_SECONDS'])
    for(const value of ['','0','-1','1.5','1e3','NaN','999999999']) assert.throws(()=>examPolicy({[name]:value}));
});

test('Start und Abgabe prüfen nach CSRF sowohl Konto/IP als auch Konto/normalisierte Prüfung',async()=>{
  const {ExamController}=require('../../apps/api/dist/exam-controller');
  const exam='abcd1234-1111-4111-8111-000000000000', user='fixture', ip='192.0.2.1';
  const calls=[],ctx={user:{id:user}}, req={ip,get:()=>''};
  const ctrl=new ExamController({require:async()=>ctx,verifyCsrf:async()=>calls.push('csrf')},
    {start:async()=>calls.push('start'),submit:async()=>calls.push('submit')},
    {hit:async(scope,key)=>calls.push([scope,key])});
  await ctrl.start(req,exam,exam.toUpperCase(),{});await ctrl.submit(req,exam,exam,exam,{});
  for(const [i,action] of ['start','submit'].entries()) assert.deepEqual(calls.slice(i*4,i*4+4),[
    'csrf',[`exam-${action}-source`,`${user}:${ip}`],[`exam-${action}-user`,`${user}:${exam}`],action]);
});
