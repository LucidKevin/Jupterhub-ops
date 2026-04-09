/**
 * 通用前端工具函数集合。
 * 这里的 `cn` 是 shadcn/tailwind 项目常用辅助：先按条件拼接 class，再去重冲突类。
 */
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** 合并多个 className 输入（字符串、对象、数组等）并处理 Tailwind 冲突。 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
