import '../util/polyfills.js';
import {
	SimpleStorage, SimpleMutableFile, MultiStoreDatabase, idbRequest, idbTransaction
} from "../util/storage.js";
import { typedArrayToBuffer, concatTypedArray } from "../util/util.js";
import { CriticalSection } from "../util/promise.js";
import { assert, unreachable, abortError } from "../util/error.js";
import { isWebExtOOPDisabled } from "./webext-oop.js";
import { S } from "./settings.js";
import { SimpleEventListener } from '../util/event.js';

type TypeOfChunkStorage = typeof ChunkStorage
export interface ChunkStorageClass extends TypeOfChunkStorage { }

export abstract class ChunkStorage {
	constructor(readonly id: number) { }
	abstract init(isLoaded: boolean): Promise<void>
	abstract load(totalSize: number): Promise<ChunkStorageWriter[]>
	abstract writer(startPosition: number): ChunkStorageWriter
	abstract persist(totalSize: number | undefined, final: boolean): Promise<void>
	abstract getFile(): Promise<File> // must call persist(totalSize, true) first
	abstract reset(): void // all writers are invalidated
	abstract delete(): void | Promise<void> // other methods can still be called
	abstract read(position: number, size: number): Promise<ArrayBuffer>
	readonly onError = new SimpleEventListener<[Error]>()
	readonly needFlush: boolean = false
}

export class ChunkStorageWriter {
	private promise = Promise.resolve()

	constructor(
		protected readonly parent: ChunkStorage | undefined,
		readonly startPosition: number,
		public writtenSize = 0,
	) { }

	private sync(fn: () => Promise<void>) {
		const result = this.promise.then(fn)
		this.promise = result.catch(error => {
			this.promise = this.promise.then(() => { }, () => { })
			if (this.parent) this.parent.onError.dispatch(error)
		})
		return result
	}

	// CANNOT reorder
	write(data: Uint8Array) { return this.sync(() => this.doWrite(data)) }
	flush() { return this.sync(() => this.doFlush()) }

	// NOT thread safe
	protected async doWrite(_data: Uint8Array) { unreachable() }
	protected async doFlush() { }
}

export class MutableFileChunkStorage extends ChunkStorage {
	private static storage = SimpleStorage.create("files")
	// Firefox 74 has removed IDBMutableFile.getFile (Bug 1607791)
	private static tempStorage = SimpleStorage.create(`files-temp-storage`)

	private get mfileName() { return `${this.id}` }// backward compatibility
	file!: SimpleMutableFile

	private readonly persistCriticalSection = new CriticalSection()
	private persistSentry = {}

	// Written at totalSize for shared files
	// [ persistenceData.length - 1, (startPosition, currentSize)...  ]
	persistenceData = new Float64Array([0])

	async init(isLoaded: boolean) {
		const storage = await MutableFileChunkStorage.storage
		let mutableFile = isLoaded ?
			(await storage.get(this.mfileName) as IDBMutableFile) : undefined
		if (!mutableFile) {
			mutableFile = await storage.mutableFile(`chunk-storage-${this.id}`)
			await storage.set(this.mfileName, mutableFile)
		}
		this.file = new SimpleMutableFile(mutableFile)
	}

	async load(totalSize: number) {
		try {
			const BYTES = Float64Array.BYTES_PER_ELEMENT
			const size = new Float64Array(await this.file.read(BYTES, totalSize))[0]
			if (!size /* 0 | undefined */) return []
			const data = new Float64Array(
				await this.file.read(BYTES * (size + 1), totalSize))
			if (data.length !== size + 1) return []
			assert(this.persistenceData.length === 1) // cannot be called after writer
			this.persistenceData = data
		} catch (error) {
			console.warn('MutableFileChunkStorage.load', this.mfileName, error)
		}

		const result: ChunkStorageWriter[] = []
		for (let i = 1; i < this.persistenceData.length; i += 2)
			result.push(new MutableFileChunkStorage.Writer(this, i))
		return result
	}

	writer(startPosition: number) {
		const persistenceIndex = this.persistenceData.length
		this.persistenceData = concatTypedArray([
			this.persistenceData, new Float64Array([startPosition, 0])
		])!
		this.persistenceData[0] += 2
		return new MutableFileChunkStorage.Writer(this, persistenceIndex)
	}

	persist(totalSize: number | undefined, final: boolean) {
		if (totalSize === undefined) return Promise.resolve()
		const sentry = this.persistSentry
		return this.persistCriticalSection.sync(async () => {
			if (sentry !== this.persistSentry) return
			if (final)
				await this.file.truncate(totalSize)
			else
				await this.file.write(typedArrayToBuffer(
					this.persistenceData) as ArrayBuffer, totalSize)
		})
	}

	// Workaround for disabling webext-oop
	private get snapshotName() { return `${this.mfileName}-snapshot` }

	async getFile() {
		if (this.file.requiresTempStorage) {
			return this.file.getFileWithTempStorage(
				await MutableFileChunkStorage.tempStorage, this.mfileName)
		}
		if (isWebExtOOPDisabled) {
			const storage = await MutableFileChunkStorage.storage
			storage.set(this.snapshotName, await this.file.getFile())
			return storage.get<File>(this.snapshotName)
		}
		return this.file.getFile()
	}

	reset() {
		this.persistenceData = new Float64Array([0])
		this.persistSentry = {}
		void this.file.truncate(0)
	}

	async delete() {
		const storage = await MutableFileChunkStorage.storage
		void storage.delete(this.mfileName)
		void storage.delete(this.snapshotName)
		const tempStorage = await MutableFileChunkStorage.tempStorage
		SimpleMutableFile.cleanupTempStorage(tempStorage, this.mfileName)
		// other methods can still access the unlinked file
	}

	read(position: number, size: number) { return this.file.read(size, position) }
}

export namespace MutableFileChunkStorage {
	export class Writer extends ChunkStorageWriter {
		constructor(
			protected readonly parent: MutableFileChunkStorage,
			persistenceIndex: number,
		) {
			super(parent, parent.persistenceData[persistenceIndex],
				parent.persistenceData[persistenceIndex + 1])
			this.writtenSizeIndex = persistenceIndex + 1
		}

		private readonly writtenSizeIndex: number

		protected async doWrite(data: Uint8Array) {
			if (!data.length) return
			const { persistenceData } = this.parent
			await this.parent.file.write(typedArrayToBuffer(data) as ArrayBuffer,
				this.startPosition + this.writtenSize)
			this.writtenSize += data.length
			persistenceData[this.writtenSizeIndex] = this.writtenSize
		}
	}
}

const SegmentsDatabaseStores = ['data', 'recovery'] as const
type SegmentsDatabase = MultiStoreDatabase<typeof SegmentsDatabaseStores>

export class SegmentedFileChunkStorage extends ChunkStorage {
	private static database = MultiStoreDatabase.create('segments', 1,
		SegmentsDatabaseStores)
	database!: SegmentsDatabase

	readonly needFlush: boolean = true
	flushSentry = {}

	async init(isLoaded: boolean) {
		this.database = await SegmentedFileChunkStorage.database
		if (!isLoaded)
			await SegmentedFileChunkStorage.delete(this.database, this.id)
	}

	static delete(database: SegmentsDatabase, id: number) {
		const { transaction, stores } = database.transaction()
		const keyRange = IDBKeyRange.bound([id], [id, []])
		stores.data.delete(keyRange)
		stores.recovery.delete(keyRange)
		return idbTransaction(transaction)
	}

	load(totalSize: number): Promise<ChunkStorageWriter[]> {
		throw new Error("Method not implemented.");
	}

	writer(startPosition: number) {
		return new SegmentedFileChunkStorage.Writer(this, startPosition)
	}

	async persist() { /* do nothing */ }

	async getFile(): Promise<File> {
		const { stores } = this.database.transaction('readonly', ['data'])
		const keyRange = IDBKeyRange.bound([this.id], [this.id, []])
		const request = stores.data.openCursor(keyRange)

		const blobs: Blob[] = []
		let nextPosition = 0

		await new Promise((resolve, reject) => {
			request.addEventListener('error', () => reject(request.error))
			request.addEventListener('abort', () => reject(abortError()))
			request.addEventListener('success', () => {
				const cursor = request.result
				if (cursor) {
					const [, startPosition] = cursor.primaryKey as [number, number]
					assert(startPosition === nextPosition)
					blobs.push(cursor.value)
					nextPosition += (cursor.value as Blob).size
					cursor.continue()
				} else resolve()
			})
		})
		return new File(blobs, "file")
	}

	async reset() {
		throw new Error("Method not implemented.");
	}

	delete() {
		this.flushSentry = {}
		return SegmentedFileChunkStorage.delete(this.database, this.id)
	}

	read(position: number, size: number): Promise<ArrayBuffer> {
		throw new Error("Method not implemented.");
	}
}

export namespace SegmentedFileChunkStorage {
	export class Writer extends ChunkStorageWriter {
		constructor(
			protected readonly parent: SegmentedFileChunkStorage,
			startPosition: number,
		) {
			super(parent, startPosition, 0)
			this.bufferPosition = this.startPosition
			this.flushSentry = this.parent.flushSentry
		}

		private bufferPosition: number
		private bufferData: Uint8Array[] = []
		private readonly flushSentry: {}

		protected async doWrite(data: Uint8Array) {
			if (!data.length) return
			this.bufferData.push(data)
			this.writtenSize += data.length
		}

		protected async doFlush() {
			if (this.flushSentry !== this.parent.flushSentry) return
			if (!this.bufferData.length) return
			const data = concatTypedArray(this.bufferData)!
			const { transaction, stores } =
				this.parent.database.transaction('readwrite', ['data'])
			stores.data.add(new Blob([data]), [this.parent.id, this.bufferPosition])
			await idbTransaction(transaction)
			this.bufferPosition += data.length
			this.bufferData = []
		}
	}
}
