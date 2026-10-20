/**
 * WorkBuddy 云服务公开配置。
 *
 * 这里的三个值来自 `workbuddy_cloud_service` 激活后返回的 `publicConfig`，
 * 都属于「前端可安全持有」的值（publishableKey 不含任何权限，且服务端按
 * Origin 严格校验），因此可以随源码发布。切勿把任何服务端密钥放进这里。
 *
 * 对应环境：应用「A股金融数据终端」(wbapp_KM6bhPdqALjYR0B7SowEuA)
 */
export const cloudPublicConfig = {
  /** 当前应用的数据面基址，每次请求都必须透传给 SDK */
  endpoint: 'https://a-share-fin-terminal.app.workbuddy.host',
  /** Web 端 OAuth 中继基址（微信/WorkBuddy 登录需要） */
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  /** 仅用于标识应用，不包含权限，可被前端持有 */
  publishableKey:
    'wbpk_KM6bhPdqALjYR0B7SowEuA_E3nA6HYzuis5atsDg24nsV07RazPJwB5',
} as const;
