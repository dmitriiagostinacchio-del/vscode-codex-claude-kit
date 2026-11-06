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

export function CodexQuotaFooter() {
  const client=useKeyedSignal(clientSignal,'local');
  const [state,setState]=React.useState({data:null,updated:null,error:false});
  React.useEffect(()=>{
    let disposed=false,busy=false,lastAttempt=0;
    const stop=new AbortController();
    setState({data:null,updated:null,error:false});
    async function refresh(){
      if(disposed||busy||!client||Date.now()-lastAttempt<5000)return;
      busy=true;lastAttempt=Date.now();
      try {
        const data=await awaitRpc(client.rpc.sendRequest('account/rateLimits/read',{},
          {timeoutMs:15000,source:'local_quota_footer'}),
          AbortSignal.any([stop.signal,AbortSignal.timeout(15000)]));
        if(!disposed)setState({data,updated:Date.now(),error:false});
      }catch(error){
        console.warn('[Codex quota footer] Read failed:',error?.message??String(error));
        if(!disposed)setState({data:null,updated:null,error:true});
      }finally{busy=false;}
    }
    void refresh();
    const timer=setInterval(refresh,60000);
    window.addEventListener('focus',refresh);
    return()=>{disposed=true;stop.abort();clearInterval(timer);window.removeEventListener('focus',refresh);};
  },[client]);
  const title=state.error ? '额度暂时无法读取；每分钟重试'
    : `剩余额度，每分钟刷新${state.updated?'；更新于 '+new Date(state.updated).toLocaleTimeString():''}。-- 表示未返回该周期额度。`;
  return jsx.jsx('span',{
    'data-codex-quota-footer':'true',title,
    style:{fontSize:'11px',whiteSpace:'nowrap',fontVariantNumeric:'tabular-nums',
      color:'var(--vscode-descriptionForeground)',marginLeft:'6px',marginRight:'6px',flexShrink:0},
    children:quotaText(state.data)
  });
}
