import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'JupyterHub 运维管理平台',
    template: '%s | JupyterHub 运维',
  },
  description:
    '基于 Docker Swarm + NFS 的 JupyterHub 集群运维管理平台，支持集群监控、服务管理、OOM 防控等全方位运维功能。',
  keywords: [
    'JupyterHub',
    'Docker Swarm',
    'NFS',
    '运维管理',
    '集群监控',
    'OOM 防控',
    '容器管理',
  ],
  authors: [{ name: 'JupyterHub Operations Team' }],
  generator: 'JupyterHub Ops Platform',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className={`antialiased`}>
        {children}
      </body>
    </html>
  );
}
