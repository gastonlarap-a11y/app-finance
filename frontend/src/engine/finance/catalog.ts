// Mirror of backend/finance/catalog.go's file: the suggested categories and
// merchants for a Chilean household, read from the same catalog.json (raw
// import, like the engine's migrations), so desktop and iPad add the same set.
import catalogJson from '../../../../backend/finance/catalog.json?raw'

export interface CatalogCategory {
  name: string
  icon: string
  color: string
}

export interface CatalogMerchant {
  name: string
  category: string // '' = sells everything (a department store): no usual category
  patterns: string[] // normalized descriptor prefixes
}

interface CatalogFile {
  categories: CatalogCategory[]
  merchants: CatalogMerchant[]
}

// The file ships with the build and backend/finance/catalog_test.go checks its
// shape, so the parse result is trusted as CatalogFile.
const file = JSON.parse(catalogJson) as CatalogFile

export const CATALOG: Readonly<CatalogFile> = file
