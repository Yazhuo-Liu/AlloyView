/* tslint:disable */
/* eslint-disable */
export interface Lattice {
    /**
     * Cartesian basis vectors concatenated as `[ax, ay, az, bx, by, bz, cx, cy, cz]`.
     * This is the column-major storage of the column-wise basis matrix.
     */
    basis: [number, number, number, number, number, number, number, number, number];
}

export interface MoyoArithmeticCrystalClass {
    arithmetic_number: number;
    symbol: string;
    geometric_crystal_class: string;
    bravais_class: string;
}

export interface MoyoCell {
    lattice: Lattice;
    positions: [number, number, number][];
    numbers: number[];
}

export interface MoyoDataset {
    number: number;
    hall_number: number;
    hm_symbol: string;
    operations: MoyoOperation[];
    orbits: number[];
    wyckoffs: string[];
    site_symmetry_symbols: string[];
    /**
     * Symmetry-refined conventional cell with a right-handed basis.
     */
    std_cell: MoyoCell;
    /**
     * Input-to-standardized coordinate transformation, stored column-major.
     * Its determinant has the same sign as the input basis determinant.
     */
    std_linear: [number, number, number, number, number, number, number, number, number];
    /**
     * Input-basis origin shift: x_selected = inverse(std_linear) * (x_input - shift).
     */
    std_origin_shift: [number, number, number];
    /**
     * Proper Cartesian rotation after symmetric lattice refinement, stored column-major.
     */
    std_rotation_matrix: [number, number, number, number, number, number, number, number, number];
    pearson_symbol: string;
    /**
     * Symmetry-refined primitive cell with a right-handed basis.
     */
    prim_std_cell: MoyoCell;
    /**
     * Input-to-primitive coordinate transformation, stored column-major.
     * Its determinant has the same sign as the input basis determinant.
     */
    prim_std_linear: [number, number, number, number, number, number, number, number, number];
    prim_std_origin_shift: [number, number, number];
    mapping_std_prim: number[];
    symprec: number;
    angle_tolerance: AngleTolerance;
}

export interface MoyoHallSymbolEntry {
    hall_number: number;
    number: number;
    arithmetic_number: number;
    setting: string;
    hall_symbol: string;
    hm_short: string;
    hm_full: string;
    centering: MoyoCentering;
}

export interface MoyoLayerArithmeticCrystalClass {
    arithmetic_number: number;
    symbol: string;
    geometric_crystal_class: string;
    bravais_class: string;
    lattice_system: string;
}

export interface MoyoLayerGroupType {
    number: number;
    hall_number: number;
    hm_short: string;
    hm_full: string;
    arithmetic_number: number;
    arithmetic_symbol: string;
    geometric_crystal_class: string;
    crystal_system: string;
    bravais_class: string;
    lattice_system: string;
}

export interface MoyoLayerHallSymbolEntry {
    hall_number: number;
    number: number;
    arithmetic_number: number;
    setting: string;
    hall_symbol: string;
    hm_short: string;
    hm_full: string;
    centering: MoyoLayerCentering;
}

export interface MoyoLayerWyckoffPosition {
    /**
     * Multiplicity in the conventional layer cell.
     */
    multiplicity: number;
    /**
     * Wyckoff letter.
     */
    letter: string;
    /**
     * Site-symmetry symbol.
     */
    site_symmetry: string;
    /**
     * Representative coordinate triplet (e.g. `x,y,z`).
     */
    coordinates: string;
}

export interface MoyoMagneticHallSymbolEntry {
    uni_number: number;
    magnetic_hall_symbol: string;
}

export interface MoyoMagneticOperation {
    rotation: [number, number, number, number, number, number, number, number, number];
    translation: [number, number, number];
    time_reversal: boolean;
}

export interface MoyoMagneticSpaceGroupType {
    uni_number: number;
    litvin_number: number;
    bns_number: string;
    og_number: string;
    number: number;
    construct_type: number;
}

export interface MoyoOperation {
    rotation: [number, number, number, number, number, number, number, number, number];
    translation: [number, number, number];
}

export interface MoyoSpaceGroupType {
    number: number;
    hall_number: number;
    hm_short: string;
    hm_full: string;
    arithmetic_number: number;
    arithmetic_symbol: string;
    geometric_crystal_class: string;
    crystal_system: string;
    bravais_class: string;
    lattice_system: string;
    crystal_family: string;
}

export interface MoyoWyckoffPosition {
    /**
     * Multiplicity in the conventional cell.
     */
    multiplicity: number;
    /**
     * Wyckoff letter.
     */
    letter: string;
    /**
     * Site-symmetry symbol.
     */
    site_symmetry: string;
    /**
     * Representative coordinate triplet (e.g. `x,y,z`).
     */
    coordinates: string;
}

export type AngleTolerance = { type: "Radian"; value: number } | { type: "Default" };

export type MoyoCentering = "P" | "A" | "B" | "C" | "I" | "R" | "F";

export type MoyoLayerCentering = "P" | "C";

export type MoyoLayerSetting = { type: "Spglib" } | { type: "Standard" } | { type: "HallNumber"; value: number };

export type MoyoSetting = { type: "Spglib" } | { type: "Standard" } | { type: "HallNumber"; value: number };


/**
 * Analyze the symmetry of a crystal structure and return the full dataset.
 *
 * `cell_json` is a JSON-encoded [`MoyoCell`] (concatenated Cartesian basis vectors,
 * fractional `positions`, atomic `numbers`). `symprec` is the distance
 * tolerance (in the same length unit as the lattice). `setting` selects the
 * standardization convention: `"Spglib"` for spglib-compatible settings,
 * anything else (e.g. `"Standard"`) for the ITA standard setting.
 * Both returned standardized bases are right-handed. Passive rebasing preserves
 * the physical space-group type, while a Cartesian mirror exchanges enantiomorphs.
 * Lattice and positions are refined, then a proper Cartesian rotation is applied.
 */
export function analyze_cell(cell_json: string, symprec: number, setting: string): MoyoDataset;

/**
 * Return the arithmetic-crystal-class entry for the given `arithmetic_number` (1 - 73).
 */
export function arithmetic_crystal_class(arithmetic_number: number): MoyoArithmeticCrystalClass;

/**
 * Return all Hall-symbol entries for the given ITA space-group `number` (1 - 230),
 * ordered by Hall number. Each entry corresponds to one setting of the space group.
 */
export function hall_symbol_entries_from_number(number: number): MoyoHallSymbolEntry[];

/**
 * Return the Hall-symbol entry for the given `hall_number` (1 - 530).
 */
export function hall_symbol_entry(hall_number: number): MoyoHallSymbolEntry;

/**
 * Return the layer arithmetic-crystal-class entry for the given `arithmetic_number` (1 - 43).
 */
export function layer_arithmetic_crystal_class(arithmetic_number: number): MoyoLayerArithmeticCrystalClass;

/**
 * Return the layer-group-type description for the given `number` (1 - 80).
 */
export function layer_group_type(number: number): MoyoLayerGroupType;

/**
 * Return all layer Hall-symbol entries for the given layer-group `number` (1 - 80),
 * ordered by Hall number. Each entry corresponds to one setting of the layer group.
 */
export function layer_hall_symbol_entries_from_number(number: number): MoyoLayerHallSymbolEntry[];

/**
 * Return the layer Hall-symbol entry for the given `hall_number` (1 - 116).
 */
export function layer_hall_symbol_entry(hall_number: number): MoyoLayerHallSymbolEntry;

/**
 * Return all Wyckoff positions for the given layer Hall number (1 - 116), ordered
 * general-position-first then descending multiplicity. Returns an empty array for
 * unknown Hall numbers.
 */
export function layer_wyckoff_positions(hall_number: number): MoyoLayerWyckoffPosition[];

/**
 * Return the magnetic Hall-symbol entry for the given `uni_number` (1 - 1651).
 */
export function magnetic_hall_symbol_entry(uni_number: number): MoyoMagneticHallSymbolEntry;

/**
 * Return magnetic symmetry operations for the given `uni_number` (1 - 1651).
 */
export function magnetic_operations_from_uni_number(uni_number: number, primitive: boolean): MoyoMagneticOperation[];

/**
 * Return the magnetic-space-group-type description for the given `uni_number` (1 - 1651).
 */
export function magnetic_space_group_type(uni_number: number): MoyoMagneticSpaceGroupType;

/**
 * Return symmetry operations for the given layer-group `number` (1 - 80).
 */
export function operations_from_layer_number(number: number, setting: MoyoLayerSetting, primitive: boolean): MoyoOperation[];

/**
 * Return symmetry operations for the given space-group ITA `number`.
 */
export function operations_from_number(number: number, setting: MoyoSetting, primitive: boolean): MoyoOperation[];

/**
 * Return the space-group-type description for the given ITA `number` (1 - 230).
 */
export function space_group_type(number: number): MoyoSpaceGroupType;

/**
 * Return all Wyckoff positions for the given `hall_number` (1 - 530), ordered
 * general-position-first then descending multiplicity. Returns an empty array for
 * unknown Hall numbers.
 */
export function wyckoff_positions(hall_number: number): MoyoWyckoffPosition[];

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly magnetic_hall_symbol_entry: (a: number) => [number, number, number];
    readonly magnetic_operations_from_uni_number: (a: number, b: number) => [number, number, number, number];
    readonly magnetic_space_group_type: (a: number) => [number, number, number];
    readonly layer_arithmetic_crystal_class: (a: number) => [number, number, number];
    readonly layer_group_type: (a: number) => [number, number, number];
    readonly layer_hall_symbol_entries_from_number: (a: number) => [number, number];
    readonly layer_hall_symbol_entry: (a: number) => [number, number, number];
    readonly layer_wyckoff_positions: (a: number) => [number, number];
    readonly operations_from_layer_number: (a: number, b: any, c: number) => [number, number, number, number];
    readonly analyze_cell: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly arithmetic_crystal_class: (a: number) => [number, number, number];
    readonly hall_symbol_entries_from_number: (a: number) => [number, number];
    readonly hall_symbol_entry: (a: number) => [number, number, number];
    readonly operations_from_number: (a: number, b: any, c: number) => [number, number, number, number];
    readonly space_group_type: (a: number) => [number, number, number];
    readonly wyckoff_positions: (a: number) => [number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __externref_drop_slice: (a: number, b: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
