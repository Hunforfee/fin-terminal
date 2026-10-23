'use client';
import {useEffect,useRef,useState} from 'react';
import {fetchJson} from '@/lib/fetchJson';
import {getStorageAccount,personalStorage,storageKey,PERSONAL_CHANGE} from '@/lib/personalStorage';
import {COMPANY_LEARNING_KEY,emptyLearningState,readLearningState,chooseLearningCompany,setLearningDay,toggleLearned,type LearningCandidate,type LearningState} from '@/lib/companyLearning';

export default function useCompanyLearning(codes:string[],watchReady:boolean,today:string){
  const [state,setState]=useState<LearningState>(emptyLearningState),[stored,setStored]=useState(false);
  const [pool,setPool]=useState<LearningCandidate[]>([]),[poolLoading,setPoolLoading]=useState(true);
  const [storageError,setStorageError]=useState(''),[poolError,setPoolError]=useState(''),[actionError,setActionError]=useState('');
  const [revision,setRevision]=useState(0);
  const account=useRef(getStorageAccount());
  const codesKey=codes.slice(0,2000).join(',');
  function read(){
    if(getStorageAccount()!==account.current)throw Error('账号已切换，请重新打开页面');
    return readLearningState(personalStorage.getItem(COMPANY_LEARNING_KEY));
  }
  function write(next:LearningState){
    if(getStorageAccount()!==account.current)throw Error('账号已切换，请重新打开页面');
    personalStorage.setItem(COMPANY_LEARNING_KEY,JSON.stringify(next));setState(next);setActionError('');
  }
  useEffect(()=>{
    const load=()=>{
      try{setState(read());setStored(true);setStorageError('');}
      catch{setStored(false);setStorageError('学习记录读取失败，原记录已保留');}
    };
    const change=(e:StorageEvent)=>{
      if(e.key!==null&&e.key!==storageKey(COMPANY_LEARNING_KEY,account.current))return;
      if(e.storageArea&&e.storageArea!==window.localStorage)return;load();
    };
    load();window.addEventListener('storage',change);window.addEventListener(PERSONAL_CHANGE,load);
    return()=>{window.removeEventListener('storage',change);window.removeEventListener(PERSONAL_CHANGE,load);};
    // AccountProvider recreates this hook when changing accounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[revision]);
  useEffect(()=>{
    if(!watchReady)return;
    const controller=new AbortController();setPoolLoading(true);setPoolError('');
    fetchJson('/api/company-learning',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'pool',codes:codesKey?codesKey.split(','):[]}),signal:controller.signal})
      .then((j)=>{if(!j.ok||!Array.isArray(j.data)||!j.data.length)throw Error('候选公司暂不可用');if(!controller.signal.aborted)setPool(j.data);})
      .catch(()=>{if(!controller.signal.aborted)setPoolError('候选公司暂不可用，请重试');})
      .finally(()=>{if(!controller.signal.aborted)setPoolLoading(false);});
    return()=>controller.abort();
  },[codesKey,watchReady,revision]);
  useEffect(()=>{
    if(!stored||!today||!pool.length||state.days.some(d=>d.date===today))return;
    try{const latest=read(),day=chooseLearningCompany(pool,latest,today);if(day)write(setLearningDay(latest,day));}
    catch{setActionError('今日公司未保存，请重试');}
    // The persisted calendar date protects today's choice from watchlist/pool changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[stored,today,pool,state.days]);
  function swap(){
    try{const latest=read(),day=chooseLearningCompany(pool,latest,today,true);if(!day){setActionError('本日候选公司已看完');return;}write(setLearningDay(latest,day));}
    catch{setActionError('暂未切换公司，原记录已保留');}
  }
  function mark(company:LearningCandidate){
    try{write(toggleLearned(read(),company,today));return true;}
    catch{setActionError('学习状态未保存，原记录已保留');return false;}
  }
  return {state,selected:state.days.find(d=>d.date===today)??null,ready:stored&&!poolLoading&&!!today,
    error:storageError||poolError||actionError,swap,mark,retry:()=>{setActionError('');setRevision(v=>v+1);}};
}
