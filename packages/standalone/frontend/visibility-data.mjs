export function visibilityCopy(locale) {
  const language = String(locale).toLowerCase()
  if (language.startsWith('en')) return {
    hideFree: 'Hide anonymous and Kilo free models',
    hideEac: 'Hide EAC models',
    hide: 'Hide model',
    show: 'Show model',
    hidden: 'Hidden by preference',
    groupHidden: 'Turn off group hiding first',
    saved: 'Model visibility saved',
  }
  if (language.startsWith('id')) return {
    hideFree: 'Sembunyikan model gratis anonim dan Kilo',
    hideEac: 'Sembunyikan model EAC',
    hide: 'Sembunyikan model',
    show: 'Tampilkan model',
    hidden: 'Disembunyikan sesuai preferensi',
    groupHidden: 'Matikan penyembunyian seluruh grup terlebih dahulu',
    saved: 'Pengaturan visibilitas model tersimpan',
  }
  return {
    hideFree: 'Sembunyikan model gratis anonim dan Kilo',
    hideEac: 'Sembunyikan model EAC',
    hide: 'Sembunyikan model',
    show: 'Tampilkan model',
    hidden: 'Disembunyikan sesuai preferensi',
    groupHidden: 'Matikan penyembunyian seluruh grup terlebih dahulu',
    saved: 'Pengaturan visibilitas model tersimpan',
  }
}
