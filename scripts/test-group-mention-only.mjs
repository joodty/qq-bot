import assert from 'node:assert/strict';
import {bridgeHarness} from './audit-bridge-harness.mjs';
import * as roleCard from '../src/role-card.js';

const groups=['100001','100002'];
const h=await bridgeHarness({config:{groupMentionOnly:true,allow:{groups,private:[]},ownerQQ:null,ackMessage:'',social:{enabled:false,proactiveEnabled:false},socialV2:{enabled:false}},globals:roleCard});
const text=(value)=>({type:'text',data:{text:value}});
const at=(qq)=>({type:'at',data:{qq}});
const event=(message,extra={})=>({self_id:99001122,user_id:88001122,group_id:groups[0],message_id:22,message,sender:{nickname:'fixture'},...extra});
let checks=0;
try{
 h.setMode('chat');
 assert.equal(h.cfg.groupMentionOnly,true);
 const ignored=[
  event([text('你好')]),
  event([text('DeepSeek @99001122 你好')]),
  event([text('[CQ:at,qq=99001122] 你好')]),
  event([at('all'),text('你好')]),
  event([at('12345'),text('你好')]),
  event([{type:'reply',data:{id:'123'}},text('你好')]),
  event([{type:'image',data:{file:'fixture.png'}}]),
  event([{type:'face',data:{id:14}}]),
  event([text('/status')]),
  event([at('99001122'),text('你好')],{self_id:undefined}),
  event([at('99001122'),text('你好')],{self_id:'bad-id'}),
  event([at('99001122'),text('你好')],{self_id:99001123}),
  event([at('99001122'),text('你好')],{group_id:'99999999'}),
 ];
 for(const item of ignored){await h.handleIncoming('group',item.group_id,item,h.cfg);checks++;}
 assert.equal(h.calls.prompts.length,0,'unmentioned or unauthorized messages must not invoke AI');
 assert.equal(h.calls.created.length,0,'ignored messages must not create sessions');
 assert.equal(h.calls.sent.length,0,'ignored messages must not generate command/error replies');
 assert.equal(h.calls.images.length,0,'ignored images must not be downloaded');
 assert.equal(h.calls.faces.length,0,'ignored faces must not be downloaded');
 assert.equal(h.calls.http.length,0,'ignored messages must not make HTTP requests');
 for(const [index,id] of groups.entries()){
  const item=event([at(index?'99001122':99001122),text('你好')],{group_id:id});
  await h.handleIncoming('group',id,item,h.cfg);
  assert.equal(h.calls.prompts.length,index+1,'each allowed group must accept a real self mention');
  checks++;
 }
 await h.handleIncoming('private','88001122',event([text('你好')]),h.cfg);
 assert.equal(h.calls.prompts.length,2,'private chats must remain denied');checks++;
 const imageMention=event([at('99001122'),text('看图'),{type:'image',data:{file:'fixture.png'}}]);
 await h.handleIncoming('group',groups[0],imageMention,h.cfg);
 assert.equal(h.calls.prompts.length,3,'a real mention with an image must still reach AI');checks++;
 console.log(JSON.stringify({passed:true,scenarios:checks,groupMentionOnly:true,privateDenied:true,ignoredMessagesInvokeAI:false}));
}finally{await h.close();}
