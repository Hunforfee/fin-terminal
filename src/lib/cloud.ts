'use client';

/**
 * WorkBuddy 云服务客户端单例。
 *
 * 走 npm 包形式（项目有 Next.js 构建步骤）。所有模块（auth / database /
 * storage / llm）共享同一个 client 实例，登录后请求层会自动带上当前会话。
 *
 * 为避免 Next.js 服务端渲染（SSR）阶段访问浏览器全局对象，这里用惰性初始化：
 * 只有在浏览器里第一次调用 getCloud() 时才真正创建 client，服务端不会触碰 window。
 */
import { createWorkBuddyCloud } from '@tencent-ai/workbuddy-cloud-sdk';
import { cloudPublicConfig } from './cloudPublic';

type CloudClient = ReturnType<typeof createWorkBuddyCloud>;

let client: CloudClient | null = null;

/** 仅在浏览器中可用的云服务客户端；服务端调用会抛错（正常现象，不应在服务端调用）。 */
export function getCloud(): CloudClient {
  if (typeof window === 'undefined')
    throw new Error('云服务客户端只能在浏览器中使用');
  if (!client) {
    client = createWorkBuddyCloud({
      endpoint: cloudPublicConfig.endpoint,
      oauthRelayBaseUrl: cloudPublicConfig.oauthRelayBaseUrl,
      publishableKey: cloudPublicConfig.publishableKey,
    });
  }
  return client;
}

export const cloud = getCloud;
