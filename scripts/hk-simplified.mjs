import {Converter} from 'opencc-js';
const convert=Converter({from:'hk',to:'cn'});
export function simplified(value){
 if(typeof value==='string')return /^https?:\/\//i.test(value)?value:convert(value);
 if(Array.isArray(value))return value.map(simplified);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,simplified(v)]));
 return value;
}
