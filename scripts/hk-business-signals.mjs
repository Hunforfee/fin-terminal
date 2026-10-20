import {simplified} from './hk-simplified.mjs';
/** Terms must occur in this issuer's business description, never in a sector template. */
export function businessSignals(main){
 const text=simplified(main||'');
 const terms=['电力零售','输配电','智慧能源','可再生能源','天然气','核能','发电','供电','煤炭','矿石','冶炼','钢材','化学品','塑料','水泥','玻璃','包装','印刷','纺织','服装','鞋履','珠宝','食品','饮料','乳制品','啤酒','餐饮','酒店','物业租赁','物业管理','房地产开发','住宅','商业物业','停车场','港口','仓储','物流','航运','航空','铁路','汽车零部件','汽车','融资租赁','贷款','存款','信贷','保险经纪','保险','资产管理','投资管理','证券经纪','支付','清算','金融数据','云服务','数据中心','软件','电子商务','电子元件','电子产品','通信设备','半导体','芯片','显示器','摄像头','光学','电池','电动工具','机械','医疗器械','医疗设备','药品','药物','诊断','医院','医疗服务','教育','广告','游戏','影视','音乐','机器人','激光雷达'];
 const products=terms.filter(x=>text.includes(x)).filter(x=>!terms.some(y=>y!==x&&y.includes(x)&&text.includes(y))).slice(0,6);
 const regions=['香港','中国内地','中国大陆','澳门','台湾','东南亚','东亚','澳洲','澳大利亚','印度','欧洲','北美','美国','日本','韩国','英国','德国'].filter(x=>text.includes(x)).slice(0,4);
 return {products,regions,text:[products.length?`在取得的主营说明中，具体涉及${products.join('、')}。`:'',regions.length?`资料提及的经营地区包括${regions.join('、')}。`:''].join('')};
}
