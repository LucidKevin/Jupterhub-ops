/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  basePath: '/ops',
  // sql.js 含 WASM / 特殊模块格式，避免被 Webpack 打进包导致 exports 报错（仅服务端 API 使用）
  experimental: {
    serverComponentsExternalPackages: ['sql.js'],
  },
  // Node.js 16 兼容配置
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'lf-coze-web-cdn.coze.cn',
        pathname: '/**',
      },
    ],
  },
  webpack: (config, { isServer }) => {
    // 兼容旧版 Node.js
    config.externals = config.externals || [];
    if (isServer) {
      config.externals.push({
        'utf-8-validate': 'commonjs utf-8-validate',
        'bufferutil': 'commonjs bufferutil',
      });
      // Route Handler 等仍走 webpack 服务端打包时，保持 Node require，勿改写 sql.js 的 exports
      config.externals.push('sql.js');
    }
    return config;
  },
}

module.exports = nextConfig
