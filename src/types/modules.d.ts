declare module 'unzipper' {
    import { Readable } from 'stream';

    export interface File {
        path: string;
        type: string;
        uncompressedSize: number;
        lastModifiedDateTime: string;
        stream(password?: string): Readable;
    }

    export interface Directory {
        files: File[];
    }

    export namespace Open {
        function file(path: string): Promise<Directory>;
    }
}

declare module 'lzma-native' {
    import { Transform } from 'stream';
    export function createDecompressor(): Transform;
}

declare module 'unbzip2-stream' {
    import { Transform } from 'stream';
    function bz2(): Transform;
    export = bz2;
}

declare module 'zstd-codec' {
    export const ZstdCodec: any;
}

declare module 'node-7z' {
    interface Options {
        $bin?: string;
        $raw?: string[];
    }

    interface SevenZipStream {
        on(event: 'data', listener: (data: any) => void): SevenZipStream;
        on(event: 'end', listener: () => void): SevenZipStream;
        on(event: 'error', listener: (error: Error) => void): SevenZipStream;
        kill(): void;
    }

    export function list(archive: string, options?: Options): SevenZipStream;
    export function extractFull(archive: string, output: string, options?: Options): SevenZipStream;
}

declare module '7zip-bin' {
    export const path7za: string;
}