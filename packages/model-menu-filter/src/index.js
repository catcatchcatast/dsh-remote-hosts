export const name = 'model-menu-filter'
export const inject = ['sessionController']

export function filterCatalog(catalog, config = {}) {
  const only = config.onlyModels ?? {}
  const excluded = new Set(config.excludeModels ?? [])
  if (!Object.keys(only).length && !excluded.size) return catalog
  return {
    ...catalog,
    groups: catalog.groups.map(group => ({
      ...group,
      models: group.models.filter(model =>
        (!Object.hasOwn(only, group.id) || only[group.id].includes(model.id)) && !excluded.has(model.id)),
    })).filter(group => group.models.length > 0),
  }
}

export function apply(ctx, config = {}) {
  const controller = ctx.sessionController
  return ctx.effect(() => {
    const descriptor = Object.getOwnPropertyDescriptor(controller, 'modelCatalog')
    const original = controller.modelCatalog
    async function modelCatalog(...args) {
      return filterCatalog(await original.apply(this, args), config)
    }
    Object.defineProperty(controller, 'modelCatalog', {
      configurable: true, writable: true, value: modelCatalog,
      enumerable: descriptor?.enumerable ?? false,
    })
    return () => {
      if (Object.getOwnPropertyDescriptor(controller, 'modelCatalog')?.value !== modelCatalog) return
      if (descriptor) Object.defineProperty(controller, 'modelCatalog', descriptor)
      else delete controller.modelCatalog
    }
  }, 'model-menu-filter: advisory catalog only')
}
