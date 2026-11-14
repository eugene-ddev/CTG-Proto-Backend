export const isDebugMode = (ctx: nkruntime.Context): boolean => (ctx.env && ctx.env['CTG_DEBUG']) === 'true'
