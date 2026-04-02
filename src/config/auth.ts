export const AUTH_COOKIE_NAME = 'jupyterhub_ops_session';
export const AUTH_SESSION_TTL_SECONDS = 60 * 60 * 8; // 8 hours

export const LDAP_CONFIG = {
  serverAddress: 'ad.fql.com',
  serverPort: 389,
  bindDnTemplates: [
    'CN={username},OU=平台研发组,OU=大数据中心,OU=T线,OU=乐信,DC=lexinfintech,DC=com',
    'CN={username},OU=数据分析组,OU=大数据中心,OU=T线,OU=乐信,DC=lexinfintech,DC=com',
    'CN={username},OU=数据架构组,OU=大数据中心,OU=T线,OU=乐信,DC=lexinfintech,DC=com',
    'CN={username},OU=数据产品组,OU=大数据中心,OU=T线,OU=乐信,DC=lexinfintech,DC=com',
    'CN={username},OU=数仓开发组,OU=大数据中心,OU=T线,OU=乐信,DC=lexinfintech,DC=com',
    'CN={username},OU=大数据中心,OU=T线,OU=乐信,DC=lexinfintech,DC=com',
    'CN={username},OU=消金创新策略中心,OU=消金风险策略部,OU=R线,OU=乐信,DC=lexinfintech,DC=com',
    'CN={username},OU=策略一组,OU=消金基础策略中心,OU=消金风险策略部,OU=R线,OU=乐信,DC=lexinfintech,DC=com',
    'CN={username},OU=策略二组,OU=消金基础策略中心,OU=消金风险策略部,OU=R线,OU=乐信,DC=lexinfintech,DC=com',
    'CN={username},OU=策略三组,OU=消金基础策略中心,OU=消金风险策略部,OU=R线,OU=乐信,DC=lexinfintech,DC=com',
    'CN={username},OU=策略四组,OU=消金基础策略中心,OU=消金风险策略部,OU=R线,OU=乐信,DC=lexinfintech,DC=com',
    'CN={username},OU=普惠风险策略部,OU=R线,OU=乐信,DC=lexinfintech,DC=com',
    'CN={username},OU=反欺诈组,OU=通用风险中心,OU=R线,OU=乐信,DC=lexinfintech,DC=com',
  ],
} as const;

