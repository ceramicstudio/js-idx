import type { CeramicApi, Doctype } from '@ceramicnetwork/common'
import type DocID from '@ceramicnetwork/docid'
import { definitions, schemas } from '@ceramicstudio/idx-constants'
import DataLoader from 'dataloader'

import { DoctypeProxy } from './doctypes'
import type { Aliases, DefinitionWithID, Entry, Index, IndexKey } from './types'
import { toDocIDString } from './utils'

export * from './types'
export * from './utils'

export interface CreateOptions {
  pin?: boolean
}

export interface IDXOptions {
  aliases?: Aliases
  autopin?: boolean
  ceramic: CeramicApi
}

export class IDX {
  _aliases: Aliases
  _autopin: boolean
  _ceramic: CeramicApi
  _docLoader: DataLoader<string, Doctype>
  _indexProxy: DoctypeProxy

  constructor({ aliases = {}, autopin, ceramic }: IDXOptions) {
    this._aliases = { ...definitions, ...aliases }
    this._autopin = autopin !== false
    this._ceramic = ceramic

    this._docLoader = new DataLoader(async (ids: ReadonlyArray<string>) => {
      return await Promise.all(ids.map(async (id) => await this._ceramic.loadDocument<Doctype>(id)))
    })
    this._indexProxy = new DoctypeProxy(this._getOwnIDXDoc.bind(this))
  }

  get authenticated(): boolean {
    return this._ceramic.did != null
  }

  get ceramic(): CeramicApi {
    return this._ceramic
  }

  get id(): string {
    if (this._ceramic.did == null) {
      throw new Error('Ceramic instance is not authenticated')
    }
    return this._ceramic.did.id
  }

  // High-level APIs

  async has(name: string, did?: string): Promise<boolean> {
    const key = this._toIndexKey(name)
    const ref = await this._getReference(key, did)
    return ref != null
  }

  async get<T = unknown>(name: string, did?: string): Promise<T | null> {
    const key = this._toIndexKey(name)
    return await this._getRecord(key, did)
  }

  async set(name: string, content: unknown, options?: CreateOptions): Promise<DocID> {
    const key = this._toIndexKey(name)
    return await this._setRecord(key, content, options)
  }

  async merge<T extends Record<string, unknown> = Record<string, unknown>>(
    name: string,
    content: T,
    options?: CreateOptions
  ): Promise<DocID> {
    const key = this._toIndexKey(name)
    const existing = await this._getRecord<T>(key)
    const newContent = existing ? { ...existing, ...content } : content
    return await this._setRecord(key, newContent, options)
  }

  async setAll(contents: Record<string, unknown>, options?: CreateOptions): Promise<Index> {
    const updates = Object.entries(contents).map(async ([name, content]) => {
      const key = this._toIndexKey(name)
      const [created, id] = await this._setRecordOnly(key, content, options)
      return [created, key, id]
    }) as Array<Promise<[boolean, IndexKey, DocID]>>
    const changes = await Promise.all(updates)

    const newReferences = changes.reduce((acc, [created, key, id]) => {
      if (created) {
        acc[key] = id.toUrl()
      }
      return acc
    }, {} as Index)
    await this._setReferences(newReferences)

    return newReferences
  }

  async setDefaults(contents: Record<string, unknown>, options?: CreateOptions): Promise<Index> {
    const index = (await this.getIndex()) ?? {}

    const updates = Object.entries(contents)
      .map(([name, content]) => [this._toIndexKey(name), content])
      .filter(([key]) => index[key as IndexKey] == null)
      .map(async ([key, content]) => {
        const definition = await this.getDefinition(key as IndexKey)
        const id = await this._createRecord(definition, content, options)
        return { [key as IndexKey]: id.toUrl() }
      }) as Array<Promise<Index>>
    const changes = await Promise.all(updates)

    const newReferences = changes.reduce((acc, keyToID) => {
      return Object.assign(acc, keyToID)
    }, {} as Index)
    await this._setReferences(newReferences)

    return newReferences
  }

  async remove(name: string): Promise<void> {
    const key = this._toIndexKey(name)
    await this._removeReference(key)
  }

  _toIndexKey(name: string): IndexKey {
    return this._aliases[name] ?? name
  }

  // Identity Index APIs

  async getIndex(did?: string): Promise<Index | null> {
    const rootDoc =
      this.authenticated && (did === this.id || did == null)
        ? await this._indexProxy.get()
        : await this._getIDXDoc(did ?? this.id)
    return rootDoc ? (rootDoc.content as Index) : null
  }

  iterator(did?: string): AsyncIterableIterator<Entry> {
    let list: Array<[IndexKey, string]>
    let cursor = 0

    return {
      [Symbol.asyncIterator]() {
        return this
      },
      next: async (): Promise<IteratorResult<Entry>> => {
        if (list == null) {
          const index = await this.getIndex(did)
          list = Object.entries(index ?? {})
        }
        if (cursor === list.length) {
          return { done: true, value: null }
        }

        const [key, id] = list[cursor++]
        const doc = await this._loadDocument(id)
        return { done: false, value: { key, id, record: doc.content } }
      },
    }
  }

  async _createIDXDoc(did: string): Promise<Doctype> {
    const doc = await this._ceramic.createDocument(
      'tile',
      {
        deterministic: true,
        metadata: { controllers: [did], family: 'IDX' },
      },
      { anchor: false, publish: false }
    )
    if (this._autopin) {
      await this._ceramic.pin.add(doc.id)
    }
    return doc
  }

  async _getIDXDoc(did: string): Promise<Doctype | null> {
    const doc = await this._createIDXDoc(did)
    if (doc.metadata.schema == null) {
      return null
    }
    if (doc.metadata.schema !== schemas.IdentityIndex) {
      throw new Error('Invalid document: schema is not IdentityIndex')
    }
    return doc
  }

  async _getOwnIDXDoc(): Promise<Doctype> {
    const doc = await this._createIDXDoc(this.id)
    if (doc.metadata.schema == null) {
      // Doc just got created, need to update it with schema
      await doc.change({ metadata: { ...doc.metadata, schema: schemas.IdentityIndex } })
    } else if (doc.metadata.schema !== schemas.IdentityIndex) {
      throw new Error('Invalid document: schema is not IdentityIndex')
    }
    return doc
  }

  // Definition APIs

  async getDefinition(idOrKey: DocID | IndexKey): Promise<DefinitionWithID> {
    const doc = await this._loadDocument(idOrKey)
    if (doc.metadata.schema !== schemas.Definition) {
      throw new Error('Invalid document: schema is not Definition')
    }
    return { ...doc.content, id: doc.id } as DefinitionWithID
  }

  // Record APIs

  async getRecordID(key: IndexKey, did?: string): Promise<string | null> {
    return await this._getReference(key, did)
  }

  async getRecordDocument(key: IndexKey, did?: string): Promise<Doctype | null> {
    const id = await this.getRecordID(key, did)
    if (id == null) {
      return null
    }
    return (await this._loadDocument(id)) ?? null
  }

  async _getRecord<T = unknown>(key: IndexKey, did?: string): Promise<T | null> {
    const doc = await this.getRecordDocument(key, did)
    return doc ? (doc.content as T) : null
  }

  async _setRecord(key: IndexKey, content: unknown, options?: CreateOptions): Promise<DocID> {
    const [created, id] = await this._setRecordOnly(key, content, options)
    if (created) {
      await this._setReference(key, id)
    }
    return id
  }

  async _setRecordOnly(
    key: IndexKey,
    content: unknown,
    { pin }: CreateOptions = {}
  ): Promise<[boolean, DocID]> {
    const existing = await this._getReference(key, this.id)
    if (existing == null) {
      const definition = await this.getDefinition(key)
      const ref = await this._createRecord(definition, content, { pin })
      return [true, ref]
    } else {
      const doc = await this._loadDocument(existing)
      await doc.change({ content })
      return [false, doc.id]
    }
  }

  async _loadDocument(id: DocID | string): Promise<Doctype> {
    return await this._docLoader.load(toDocIDString(id))
  }

  async _createRecord(
    definition: DefinitionWithID,
    content: unknown,
    { pin }: CreateOptions = {}
  ): Promise<DocID> {
    const metadata = { controllers: [this.id], family: definition.id.toString() }
    // Doc must first be created in a deterministic way
    const doc = await this._ceramic.createDocument(
      'tile',
      { deterministic: true, metadata },
      { anchor: false, publish: false }
    )
    // Then be updated with content and schema
    const updated = doc.change({ content, metadata: { ...metadata, schema: definition.schema } })
    if (pin ?? this._autopin) {
      await Promise.all([updated, this._ceramic.pin.add(doc.id)])
    } else {
      await updated
    }
    return doc.id
  }

  // References APIs

  async _getReference(key: IndexKey, did?: string): Promise<string | null> {
    const index = await this.getIndex(did ?? this.id)
    return index?.[key] ?? null
  }

  async _setReference(key: IndexKey, id: DocID): Promise<void> {
    await this._indexProxy.changeContent<Index>((index) => {
      return { ...index, [key]: id.toUrl() }
    })
  }

  async _setReferences(references: Index): Promise<void> {
    if (Object.keys(references).length !== 0) {
      await this._indexProxy.changeContent<Index>((index) => {
        return { ...index, ...references }
      })
    }
  }

  async _removeReference(key: IndexKey): Promise<void> {
    await this._indexProxy.changeContent<Index>(({ [key]: _remove, ...index }) => {
      return index
    })
  }
}
