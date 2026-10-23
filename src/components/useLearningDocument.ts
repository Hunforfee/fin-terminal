'use client';
import {useEffect,useState} from 'react';
import {fetchJson} from '@/lib/fetchJson';

export default function useLearningDocument<T>(symbol:string,date:string,view:'brief'|'full',enabled=true){
  const key=`${symbol}|${date}|${view}`;
  const [revision,setRevision]=useState(0);
  const [state,setState]=useState<{key:string;data:T|null;loading:boolean;error:string}>({key:'',data:null,loading:false,error:''});
  useEffect(()=>{
    if(!enabled||!symbol||!date)return;
    const controller=new AbortController();setState({key,data:null,loading:true,error:''});
    fetchJson(`/api/company-learning?code=${encodeURIComponent(symbol)}&view=${view}`,{signal:controller.signal})
      .then((j)=>{if(!j.ok||j.data?.symbol!==symbol)throw Error(j.error||'公司资料暂不可用');if(!controller.signal.aborted)setState({key,data:j.data,loading:false,error:''});})
      .catch(()=>{if(!controller.signal.aborted)setState({key,data:null,loading:false,error:'公司资料暂不可用，请重试或换一家公司'});});
    return()=>controller.abort();
  },[key,symbol,date,view,enabled,revision]);
  return {data:state.key===key?state.data:null,error:state.key===key?state.error:'',loading:enabled&&!!symbol&&(state.key!==key||state.loading),retry:()=>setRevision(v=>v+1)};
}
