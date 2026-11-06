import {rS as react,ym as jsxRuntime} from './app-initial-13f932cb2f13.js';
import {c as useKeyedSignal} from './app-scope-2dce3358324c.js';
import {i as initializeClients,n as clientSignal} from './app-server-client-signals-46e112ab39dd.js';
import {t as awaitRpc} from './await-rpc-request-70d86d45a758.js';

initializeClients();
const React=react(), jsx=jsxRuntime();

export function quotaText(response) {
  const snapshot=response?.rateLimitsByLimitId?.codex ?? response?.rateLimits;
  const windows=[snapshot?.primary,snapshot?.secondary];
  const percent=minutes=>{
    const bucket=windows.find(w=>w?.windowDurationMins===minutes);
    return typeof bucket?.usedPercent==='number' && Number.isFinite(bucket.usedPercent)
      ? `${Math.round(Math.max(0,Math.min(100,100-bucket.usedPercent)))}%` : '--';
  };
  return `5h ${percent(300)} | 1week ${percent(10080)}`;
}

export function quotaTooltip(response,error=false,now=Date.now()) {
  const snapshot=response?.rateLimitsByLimitId?.codex ?? response?.rateLimits;
  const windows=[snapshot?.primary,snapshot?.secondary];
  const reset=minutes=>{
    if(error)return '暂时无法读取';
    const seconds=windows.find(w=>w?.windowDurationMins===minutes)?.resetsAt;
    if(typeof seconds!=='number'||!Number.isFinite(seconds)||seconds<=0)return '未提供重置时间';
    const date=new Date(seconds*1000);
    if(!Number.isFinite(date.getTime()))return '未提供重置时间';
    const at=date.toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
    if(seconds*1000<=now)return `${at}（等待服务端更新）`;
    const total=Math.ceil((seconds*1000-now)/60000);
    const days=Math.floor(total/1440),hours=Math.floor(total%1440/60),mins=total%60;
    const remaining=(days?days+'天':'')+(hours?hours+'小时':'')+(mins?mins+'分钟':'');
    return `${at} 重置（还有 ${remaining}）`;
  };
  return `5h：${reset(300)}\n周额度：${reset(10080)}`;
}

export function CodexQuotaFooter() {
  const client=useKeyedSignal(clientSignal,'local');
  const [state,setState]=React.useState({data:null,error:false});
  React.useEffect(()=>{
    let disposed=false,busy=false,lastAttempt=0;
    const stop=new AbortController();
    setState({data:null,error:false});
    async function refresh(){
      if(disposed||busy||!client||Date.now()-lastAttempt<5000)return;
      busy=true;lastAttempt=Date.now();
      try {
        const data=await awaitRpc(client.rpc.sendRequest('account/rateLimits/read',{},
          {timeoutMs:15000,source:'local_quota_footer'}),
          AbortSignal.any([stop.signal,AbortSignal.timeout(15000)]));
        if(!disposed)setState({data,error:false});
      }catch(error){
        console.warn('[Codex quota footer] Read failed:',error?.message??String(error));
        if(!disposed)setState({data:null,error:true});
      }finally{busy=false;}
    }
    void refresh();
    const timer=setInterval(refresh,60000);
    window.addEventListener('focus',refresh);
    return()=>{disposed=true;stop.abort();clearInterval(timer);window.removeEventListener('focus',refresh);};
  },[client]);
  return jsx.jsx('span',{
    'data-codex-quota-footer':'true',title:quotaTooltip(state.data,state.error),
    onMouseEnter:event=>{event.currentTarget.title=quotaTooltip(state.data,state.error);},
    style:{fontSize:'11px',whiteSpace:'nowrap',fontVariantNumeric:'tabular-nums',
      color:'var(--vscode-descriptionForeground)',marginLeft:'6px',marginRight:'6px',flexShrink:0},
    children:quotaText(state.data)
  });
}
