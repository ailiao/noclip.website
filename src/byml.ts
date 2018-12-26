
import ArrayBufferSlice from "./ArrayBufferSlice";
import { assert, readString, align } from "./util";
import { Endianness } from "./endian";

export const enum FileType {
    BYML,
    CRG1, // Jasper's BYML variant with extensions.
}

const enum NodeType {
    STRING       = 0xA0,
    ARRAY        = 0xC0,
    DICT         = 0xC1,
    STRING_TABLE = 0xC2,
    BINARY_DATA  = 0xCB, // CRG1 extension.
    BOOL         = 0xD0,
    INT          = 0xD1,
    FLOAT        = 0xD2,
    SHORT        = 0xD3,
    FLOAT_ARRAY  = 0xE2, // CRG1 extension.
    NULL         = 0xFF,
}

interface FileDescription {
    magics: string[];
    allowedNodeTypes: NodeType[];
}

const fileDescriptions: { [key: number]: FileDescription } = {
    [FileType.BYML]: {
        magics: ['BY\0\x01', 'BY\0\x02', 'YB\x03\0'],
        allowedNodeTypes: [ NodeType.STRING, NodeType.ARRAY, NodeType.DICT, NodeType.STRING_TABLE, NodeType.BOOL, NodeType.INT, NodeType.SHORT, NodeType.FLOAT, NodeType.NULL ],
    },
    [FileType.CRG1]: {
        magics: ['CRG1'],
        allowedNodeTypes: [ NodeType.STRING, NodeType.ARRAY, NodeType.DICT, NodeType.STRING_TABLE, NodeType.BOOL, NodeType.INT, NodeType.SHORT, NodeType.FLOAT, NodeType.NULL, NodeType.FLOAT_ARRAY, NodeType.BINARY_DATA ],
    },
}

const utf8Decoder = new TextDecoder('utf8');
function readStringUTF8(buffer: ArrayBufferSlice, offs: number): string {
    const buf = buffer.createTypedArray(Uint8Array, offs);
    let i = 0;
    while (true) {
        if (buf[i] === 0)
            break;
        i++;
    }
    return utf8Decoder.decode(buffer.createTypedArray(Uint8Array, offs, i));
}

export type StringTable = string[];
export type ComplexNode = NodeDict | NodeArray | StringTable | ArrayBufferSlice | Float32Array;
export type SimpleNode = number | string | boolean | null;
export type Node = ComplexNode | SimpleNode;

export interface NodeDict { [key: string]: Node; }
export interface NodeArray extends Array<Node> {}

class ParseContext {
    constructor(public fileType: FileType, public endianness: Endianness) {}
    public get littleEndian() { return this.endianness === Endianness.LITTLE_ENDIAN; }
    public strKeyTable: StringTable = null;
    public strValueTable: StringTable = null;
}

function parseStringTable(context: ParseContext, buffer: ArrayBufferSlice, offs: number): StringTable {
    const view = buffer.createDataView();
    const header = view.getUint32(offs + 0x00, context.littleEndian);
    const nodeType: NodeType = header & 0x000000FF;
    const numValues: number = header >>> 8;
    assert(nodeType === NodeType.STRING_TABLE);

    let stringTableIdx: number = offs + 0x04;
    const strings: StringTable = [];
    for (let i = 0; i < numValues; i++) {
        const strOffs = offs + view.getUint32(stringTableIdx, context.littleEndian);
        strings.push(readStringUTF8(buffer, strOffs));
        stringTableIdx += 0x04;
    }
    return strings;
}

function parseDict(context: ParseContext, buffer: ArrayBufferSlice, offs: number): NodeDict {
    const view = buffer.createDataView();
    const header = view.getUint32(offs + 0x00, context.littleEndian);
    const nodeType: NodeType = header & 0x000000FF;
    const numValues: number = header >>> 8;
    assert(nodeType === NodeType.DICT);

    const result: NodeDict = {};
    let dictIdx = offs + 0x04;
    for (let i = 0; i < numValues; i++) {
        const entryHeader = view.getUint32(dictIdx + 0x00, context.littleEndian);
        const entryStrKeyIdx = entryHeader & 0x00FFFFFF;
        const entryNodeType: NodeType = entryHeader >>> 24;
        const entryKey = context.strKeyTable[entryStrKeyIdx];
        const entryValue = parseNode(context, buffer, entryNodeType, dictIdx + 0x04);
        result[entryKey] = entryValue;
        dictIdx += 0x08;
    }
    return result;
}

function parseArray(context: ParseContext, buffer: ArrayBufferSlice, offs: number): NodeArray {
    const view = buffer.createDataView();
    const header = view.getUint32(offs + 0x00, context.littleEndian);
    const nodeType: NodeType = header & 0x000000FF;
    const numValues: number = header >>> 8;
    assert(nodeType === NodeType.ARRAY);

    const result: NodeArray = [];
    let entryTypeIdx = offs + 0x04;
    let entryOffsIdx = align(entryTypeIdx + numValues, 4);
    for (let i = 0; i < numValues; i++) {
        const entryNodeType: NodeType = view.getUint8(entryTypeIdx);
        result.push(parseNode(context, buffer, entryNodeType, entryOffsIdx));
        entryTypeIdx++;
        entryOffsIdx += 0x04;
    }
    return result;
}

function parseComplexNode(context: ParseContext, buffer: ArrayBufferSlice, offs: number, expectedNodeType?: NodeType): ComplexNode {
    const view = buffer.createDataView();
    const header = view.getUint32(offs + 0x00, context.littleEndian);
    const nodeType: NodeType = header & 0x000000FF;
    const numValues: number = header >>> 8;
    if (expectedNodeType !== undefined)
        assert(expectedNodeType === nodeType);
    switch(nodeType) {
    case NodeType.DICT:
        return parseDict(context, buffer, offs);
    case NodeType.ARRAY:
        return parseArray(context, buffer, offs);
    case NodeType.STRING_TABLE:
        return parseStringTable(context, buffer, offs);
    case NodeType.BINARY_DATA:
        return buffer.subarray(offs + 0x04, numValues);
    case NodeType.FLOAT_ARRAY:
        return buffer.createTypedArray(Float32Array, offs + 0x04, numValues, Endianness.BIG_ENDIAN);
    default:
        throw new Error("whoops");
    }
}

function validateNodeType(context: ParseContext, nodeType: NodeType) {
    assert(fileDescriptions[context.fileType].allowedNodeTypes.includes(nodeType));
}

function parseNode(context: ParseContext, buffer: ArrayBufferSlice, nodeType: NodeType, offs: number): Node {
    const view = buffer.createDataView();
    validateNodeType(context, nodeType);

    switch (nodeType) {
    case NodeType.ARRAY:
    case NodeType.DICT:
    case NodeType.STRING_TABLE:
    case NodeType.BINARY_DATA:
    case NodeType.FLOAT_ARRAY: {
        const complexOffs = view.getUint32(offs, context.littleEndian);
        return parseComplexNode(context, buffer, complexOffs, nodeType);
    }
    case NodeType.STRING: {
        const idx = view.getUint32(offs, context.littleEndian);
        return context.strValueTable[idx];
    }
    case NodeType.BOOL: {
        const value = view.getUint32(offs, context.littleEndian);
        assert(value === 0 || value === 1);
        return !!value;
    }
    case NodeType.INT:
    case NodeType.SHORT: {
        const value = view.getUint32(offs, context.littleEndian);
        return value;
    }
    case NodeType.FLOAT: {
        const value = view.getFloat32(offs, context.littleEndian);
        return value;
    }
    case NodeType.NULL: {
        return null;
    }
    }
}

export function parse<T>(buffer: ArrayBufferSlice, fileType: FileType = FileType.BYML): T {
    const magic = readString(buffer, 0x00, 0x04, false);
    const magics = fileDescriptions[fileType].magics;
    assert(magics.includes(magic));
    const view = buffer.createDataView();

    const littleEndian = magic.slice(0, 2) == 'YB';
    const endianness: Endianness = littleEndian ? Endianness.LITTLE_ENDIAN : Endianness.BIG_ENDIAN;
    const context: ParseContext = new ParseContext(fileType, endianness);

    const strKeyTableOffs = view.getUint32(0x04, context.littleEndian);
    const strValueTableOffs = view.getUint32(0x08, context.littleEndian);
    const rootNodeOffs = view.getUint32(0x0C, context.littleEndian);

    if (rootNodeOffs === 0)
        return {} as T;

    context.strKeyTable = strKeyTableOffs !== 0 ? parseStringTable(context, buffer, strKeyTableOffs) : null;
    context.strValueTable = strValueTableOffs !== 0 ? parseStringTable(context, buffer, strValueTableOffs) : null;
    const node = parseComplexNode(context, buffer, rootNodeOffs);
    return node as any as T;
}
