const {test}=require('node:test'),assert=require('node:assert/strict');const {readStripeFee}=require('../../apps/api/dist/stripe-fees');
const base={id:'local',order_id:'o1',remote_id:'pi_test',kind:'payment',intent:'pi_test',amount_cents:1500n,currency:'EUR'};
const tx={source:'ch_test',id:'txn_test',currency:'eur',amount:1500,fee:55,net:1445};
const charge={id:'ch_test',currency:'eur',paid:true,captured:true,amount_captured:1500,livemode:false,payment_intent:'pi_test',balance_transaction:tx};
const pi={id:'pi_test',livemode:false,status:'succeeded',currency:'eur',amount_received:1500,latest_charge:charge};
const payments=p=>({paymentIntents:{retrieve:async()=>p}});
test('only a matching captured provider balance movement proves a fee; unknown is not zero',async()=>{
 assert.equal((await readStripeFee(payments(pi),base,'test')).fee_cents,55n);assert.equal(await readStripeFee(payments({...pi,latest_charge:{...charge,balance_transaction:null}}),base,'test'),null);
 for(const delta of [{currency:'usd'},{source:'ch_else'},{amount:1501},{fee:54},{net:NaN}])await assert.rejects(readStripeFee(payments({...pi,latest_charge:{...charge,balance_transaction:{...tx,...delta}}}),base,'test'));
 await assert.rejects(readStripeFee(payments(pi),base,'live'));
 const refund={id:'re_test',status:'succeeded',currency:'eur',amount:1500,payment_intent:'pi_test',charge,balance_transaction:{...tx,source:'re_test',amount:-1500,fee:-5,net:-1495}};
 const api={refunds:{retrieve:async()=>refund}};assert.equal((await readStripeFee(api,{...base,kind:'refund',remote_id:'re_test'},'test')).fee_cents,-5n);await assert.rejects(readStripeFee(api,{...base,kind:'refund',remote_id:'re_test',intent:'pi_else'},'test'));
});
