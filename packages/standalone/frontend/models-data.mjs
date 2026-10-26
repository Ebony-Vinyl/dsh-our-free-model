/** 筛选只影响当前视图，不改变模型开关或服务端目录。 */
export function filterModels(catalog, { search = '', channel = 'all', capability = 'all', availability = 'all', access = 'all' }) {
  const query = search.trim().toLocaleLowerCase()
  return catalog.filter(model =>
    (channel === 'all' || model.channel === channel)
    && (capability === 'all' || (capability === 'vision' ? model.vision : capability === 'reasoning' ? model.reasoning : !model.vision))
    && (availability === 'all' || (model.availability ?? 'unknown') === availability)
    && (access === 'all' || (access === 'routable' ? model.routable : !model.routable))
    && `${model.name} ${model.id}`.toLocaleLowerCase().includes(query))
}
