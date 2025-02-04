// @flow

import browser from '../util/browser.js';

import {Placement} from '../symbol/placement.js';
import {PerformanceUtils} from '../util/performance.js';

import type Transform from '../geo/transform.js';
import type StyleLayer from './style_layer.js';
import type SymbolStyleLayer from './style_layer/symbol_style_layer.js';
import type Tile from '../source/tile.js';
import type {BucketPart} from '../symbol/placement.js';
import type {FogState} from './fog_helpers.js';
import BuildingIndex from '../source/building_index.js';

class LayerPlacement {
    _sortAcrossTiles: boolean;
    _currentTileIndex: number;
    _currentPartIndex: number;
    _seenCrossTileIDs: Set<number>;
    _bucketParts: Array<BucketPart>;

    constructor(styleLayer: SymbolStyleLayer) {
        this._sortAcrossTiles = styleLayer.layout.get('symbol-z-order') !== 'viewport-y' &&
            styleLayer.layout.get('symbol-sort-key').constantOr(1) !== undefined;

        this._currentTileIndex = 0;
        this._currentPartIndex = 0;
        this._seenCrossTileIDs = new Set();
        this._bucketParts = [];
    }

    continuePlacement(tiles: Array<Tile>, placement: Placement, showCollisionBoxes: boolean, styleLayer: StyleLayer, shouldPausePlacement: () => boolean): boolean {
        const bucketParts = this._bucketParts;

        while (this._currentTileIndex < tiles.length) {
            const tile = tiles[this._currentTileIndex];
            placement.getBucketParts(bucketParts, styleLayer, tile, this._sortAcrossTiles);

            this._currentTileIndex++;
            if (shouldPausePlacement()) {
                return true;
            }
        }

        if (this._sortAcrossTiles) {
            this._sortAcrossTiles = false;
            bucketParts.sort((a, b) => ((a.sortKey: any): number) - ((b.sortKey: any): number));
        }

        while (this._currentPartIndex < bucketParts.length) {
            const bucketPart = bucketParts[this._currentPartIndex];
            placement.placeLayerBucketPart(bucketPart, this._seenCrossTileIDs, showCollisionBoxes, bucketPart.symbolInstanceStart === 0);
            this._currentPartIndex++;
            if (shouldPausePlacement()) {
                return true;
            }
        }
        return false;
    }
}

class PauseablePlacement {
    placement: Placement;
    _done: boolean;
    _currentPlacementIndex: number;
    _forceFullPlacement: boolean;
    _showCollisionBoxes: boolean;
    _inProgressLayer: ?LayerPlacement;

    constructor(transform: Transform, order: Array<string>,
                forceFullPlacement: boolean,
                showCollisionBoxes: boolean,
                fadeDuration: number,
                crossSourceCollisions: boolean,
                prevPlacement?: Placement,
                fogState: ?FogState,
                buildingIndex: ?BuildingIndex
    ) {
        this.placement = new Placement(transform, fadeDuration, crossSourceCollisions, prevPlacement, fogState, buildingIndex);
        this._currentPlacementIndex = order.length - 1;
        this._forceFullPlacement = forceFullPlacement;
        this._showCollisionBoxes = showCollisionBoxes;
        this._done = false;
    }

    isDone(): boolean {
        return this._done;
    }

    continuePlacement(order: Array<string>, layers: {[_: string]: StyleLayer}, layerTiles: {[_: string]: Array<Tile>}, layerTilesInYOrder: {[_: string]: Array<Tile>}) {
        const startTime = browser.now();

        const shouldPausePlacement = () => {
            const elapsedTime = browser.now() - startTime;
            return this._forceFullPlacement ? false : elapsedTime > 2;
        };

        while (this._currentPlacementIndex >= 0) {
            const layerId = order[this._currentPlacementIndex];
            const layer = layers[layerId];
            const placementZoom = this.placement.collisionIndex.transform.zoom;
            if (layer.type === 'symbol' &&
                (!layer.minzoom || layer.minzoom <= placementZoom) &&
                (!layer.maxzoom || layer.maxzoom > placementZoom)) {

                const symbolLayer = ((layer: any): SymbolStyleLayer);
                const zOffset = symbolLayer.layout.get('symbol-z-elevate');
                if (!this._inProgressLayer) {
                    this._inProgressLayer = new LayerPlacement(symbolLayer);
                }

                const pausePlacement = this._inProgressLayer.continuePlacement(zOffset ? layerTilesInYOrder[layer.source] : layerTiles[layer.source], this.placement, this._showCollisionBoxes, layer, shouldPausePlacement);

                if (pausePlacement) {
                    PerformanceUtils.recordPlacementTime(browser.now() - startTime);
                    // We didn't finish placing all layers within 2ms,
                    // but we can keep rendering with a partial placement
                    // We'll resume here on the next frame
                    return;
                }

                delete this._inProgressLayer;
            }

            this._currentPlacementIndex--;
        }
        PerformanceUtils.recordPlacementTime(browser.now() - startTime);
        this._done = true;
    }

    commit(now: number): Placement {
        this.placement.commit(now);
        return this.placement;
    }
}

export default PauseablePlacement;
