import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent, ReactNode } from 'react';
import { useWidth } from '../../../components/charts/useWidth.js';
import { MOTION } from '../../../components/motion.js';
import { plural } from '../../../lib/format.js';
import {
  WORLD_VIEW,
  citiesText,
  clusterSites,
  markerLabel,
  markerRadius,
  panBy,
  siteLabel,
  steppedZoom,
  viewBox,
  zoomAbout,
} from './map-model.js';
import type { Marker, Site } from './map-model.js';
import { MAP_HEIGHT, MAP_WIDTH, project } from './projection.js';
import type { MapView } from './use-map-view.js';
import { worldPaths } from './world.js';

const NORTH = 84;
const SOUTH = -60;

const round = (value: number): string => String(Math.round(value * 10) / 10);
const at = (lon: number, lat: number): string => {
  const { x, y } = project(lon, lat);
  return `${round(x)} ${round(y)}`;
};
const range = (from: number, to: number, step: number): number[] => {
  const out: number[] = [];
  for (let v = from; v <= to + 1e-9; v += step) out.push(v);
  return out;
};

/** The globe's own edge in this projection (its sides curve): the water a click lets go on. */
function frame(): string {
  const lats = range(SOUTH, NORTH, 4);
  const lons = range(-180, 180, 10);
  return `M${[
    ...lons.map((lon) => at(lon, NORTH)),
    ...[...lats].reverse().map((lat) => at(180, lat)),
    ...[...lons].reverse().map((lon) => at(lon, SOUTH)),
    ...lats.map((lat) => at(-180, lat)),
  ].join('L')}Z`;
}

let framed: string | undefined;
/** The frame is the same for every map, so it is worked out once. */
const frameOnce = (): string => (framed ??= frame());

/**
 * Height over width of the map's canvas (map.css): the frame's own, or a squarer 4:3 on a phone
 * whose positions sit in one part of the world (`squarer`, which the tab decides once).
 */
const WIDE_ASPECT = MAP_HEIGHT / MAP_WIDTH;
const PHONE_ASPECT = 3 / 4;

/**
 * The part of the frame the canvas shows: the view's width, and as much height as the canvas's
 * shape gives it. On a laptop it is the view's own box; on a phone's squarer canvas it shows more
 * above and below, kept on the frame (centred on it when taller than it), so every pixel of the
 * canvas maps to the frame and the water left over is shared evenly.
 */
function shownBox(
  view: MapView['view'],
  aspect: number,
): { x: number; y: number; width: number; height: number } {
  const box = viewBox(view);
  const height = box.width * aspect;
  const centre =
    height >= MAP_HEIGHT
      ? MAP_HEIGHT / 2
      : Math.min(Math.max(view.y, height / 2), MAP_HEIGHT - height / 2);
  return { x: box.x, y: centre - height / 2, width: box.width, height };
}

/**
 * The opening, once: the coast draws, the land and borders fade in after it, and the markers pop
 * in turn (map.css); this is when the last of them has landed, after which the class comes off.
 */
const INTRO_MS = 600 + 16 * 16 + MOTION.base;

/** One deal type under a marker gives it that type's colour; a mix takes the brand's. */
const colourOf = (marker: Marker, colours: Readonly<Record<string, string>>): string =>
  (marker.dealTypes.length === 1 ? colours[marker.dealTypes[0] ?? ''] : undefined) ??
  'var(--pb-brand-primary)';

export interface WorldMapProps {
  sites: readonly Site[];
  /** Keys of the sites picked out: their marker is drawn selected. */
  selected: readonly string[];
  /** Called with the sites under the marker a reader chose, or with none when they let go. */
  onSelect: (sites: readonly Site[]) => void;
  /** A site to draw attention to without selecting it (the table row under the pointer). */
  highlighted: string | null;
  map: MapView;
  reduced: boolean;
  /** Colour by deal type code, as a CSS value. */
  colours: Readonly<Record<string, string>>;
  /** Told when the reader takes hold of the map (a drag, a key, a zoom), so a tour can stop. */
  onInteract: () => void;
  /** A phone whose opening view is a region: the canvas is 4:3, which that view fills. */
  squarer?: boolean;
}

/**
 * The drawn world with a marker on every head office. The coast draws itself once, the markers
 * drop in, and the reader moves about by dragging, the buttons, a double click, the keyboard or
 * Ctrl with the wheel. Everything here is decoration over the table beside it, which lists the
 * same positions for anyone who cannot use a map.
 */
export function WorldMap({
  sites,
  selected,
  onSelect,
  highlighted,
  map,
  reduced,
  colours,
  onInteract,
  squarer = false,
}: WorldMapProps): ReactNode {
  const [canvasRef, width] = useWidth(960);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const { view, flyTo, jumpTo, target } = map;
  const aspect = squarer ? PHONE_ASPECT : WIDE_ASPECT;
  const box = shownBox(view, aspect);
  /** Frame units one pixel takes at this view: sizes given in pixels are multiplied by it. */
  const unit = MAP_WIDTH / (width * view.k);

  const paths = worldPaths();
  const globe = frameOnce();
  const zoomStep = steppedZoom(view.k);
  const markers = useMemo(
    () => clusterSites(sites, (zoomStep * width) / MAP_WIDTH),
    [sites, zoomStep, width],
  );

  /* The opening: the coast draws and the markers pop in, once. Later markers simply appear. */
  const [intro, setIntro] = useState(!reduced);
  useEffect(() => {
    if (!intro) return;
    const timer = window.setTimeout(() => setIntro(false), INTRO_MS);
    return () => window.clearTimeout(timer);
  }, [intro]);

  const [hovered, setHovered] = useState<string | null>(null);
  const [hint, setHint] = useState(false);
  const drag = useRef<{ x: number; y: number; view: typeof view; moved: boolean } | null>(null);

  const pointOf = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (rect === undefined || rect.width === 0) return { x: view.x, y: view.y };
    return {
      x: box.x + ((clientX - rect.left) / rect.width) * box.width,
      y: box.y + ((clientY - rect.top) / rect.height) * box.height,
    };
  };

  /*
   * Ctrl or Cmd with the wheel zooms about the pointer; a plain wheel scrolls the page as usual.
   * The listener is the browser's own, not React's, because it must be able to stop the page from
   * zooming; it works from the view the map is at or flying to, so it reads nothing of a render.
   */
  useEffect(() => {
    const svg = svgRef.current;
    if (svg === null) return;
    const listener = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) {
        setHint(true);
        return;
      }
      event.preventDefault();
      onInteract();
      const current = target();
      const rect = svg.getBoundingClientRect();
      const shown = shownBox(current, aspect);
      const point =
        rect.width === 0
          ? { x: current.x, y: current.y }
          : {
              x: shown.x + ((event.clientX - rect.left) / rect.width) * shown.width,
              y: shown.y + ((event.clientY - rect.top) / rect.height) * shown.height,
            };
      jumpTo(zoomAbout(current, Math.exp(-event.deltaY * 0.0022), point));
    };
    svg.addEventListener('wheel', listener, { passive: false });
    return () => svg.removeEventListener('wheel', listener);
  }, [jumpTo, target, onInteract, aspect]);
  useEffect(() => {
    if (!hint) return;
    const timer = window.setTimeout(() => setHint(false), 1800);
    return () => window.clearTimeout(timer);
  }, [hint]);

  const onPointerDown = (event: PointerEvent<SVGSVGElement>): void => {
    if (event.button !== 0) return;
    drag.current = { x: event.clientX, y: event.clientY, view: target(), moved: false };
  };
  const onPointerMove = (event: PointerEvent<SVGSVGElement>): void => {
    const start = drag.current;
    if (start === null) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (!start.moved && Math.hypot(dx, dy) < 4) return;
    if (!start.moved) {
      start.moved = true;
      onInteract();
      setHovered(null);
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    const perPixel = MAP_WIDTH / (width * start.view.k);
    jumpTo(panBy(start.view, -dx * perPixel, -dy * perPixel));
  };
  const onPointerUp = (event: PointerEvent<SVGSVGElement>): void => {
    const start = drag.current;
    drag.current = null;
    if (start?.moved === true) event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const zoomBy = (factor: number): void => {
    onInteract();
    flyTo(zoomAbout(target(), factor), MOTION.slow);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const stride = 90 / target().k;
    const moves: Record<string, () => void> = {
      ArrowLeft: () => flyTo(panBy(target(), -stride, 0), MOTION.base),
      ArrowRight: () => flyTo(panBy(target(), stride, 0), MOTION.base),
      ArrowUp: () => flyTo(panBy(target(), 0, -stride), MOTION.base),
      ArrowDown: () => flyTo(panBy(target(), 0, stride), MOTION.base),
      '+': () => flyTo(zoomAbout(target(), 1.6), MOTION.slow),
      '=': () => flyTo(zoomAbout(target(), 1.6), MOTION.slow),
      '-': () => flyTo(zoomAbout(target(), 1 / 1.6), MOTION.slow),
      '0': () => flyTo(WORLD_VIEW, MOTION.draw),
      Escape: () => onSelect([]),
    };
    const move = moves[event.key];
    if (move === undefined) return;
    event.preventDefault();
    onInteract();
    move();
  };

  const choose = (marker: Marker): void => {
    if (drag.current?.moved === true) return;
    onInteract();
    onSelect(marker.sites);
  };

  const isSelected = (marker: Marker): boolean =>
    marker.sites.some((site) => selected.includes(site.key));
  const tip = markers.find((marker) => marker.key === hovered);

  return (
    <div
      className={`pb-map${intro ? ' is-intro' : ''}`}
      data-testid="world-map"
      role="group"
      aria-label="Map of company headquarters"
      aria-describedby="pb-map-keys"
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <div className="pb-map-canvas" ref={canvasRef}>
        <svg
          ref={svgRef}
          className={squarer ? 'pb-map-svg is-squarer' : 'pb-map-svg'}
          viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`}
          preserveAspectRatio="xMidYMid meet"
          role="group"
          aria-label={`${plural(markers.length, 'marker')} on the map`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={(event) => {
            onInteract();
            flyTo(zoomAbout(target(), 2, pointOf(event.clientX, event.clientY)), MOTION.slow);
          }}
        >
          <g aria-hidden="true">
            <path
              className="pb-map-sea"
              d={globe}
              onClick={() => {
                if (drag.current?.moved !== true) onSelect([]);
              }}
            />
            <path className="pb-map-land" d={paths.land} />
            <path className="pb-map-borders" d={paths.borders} strokeWidth={0.6 * unit} />
            <path className="pb-map-coast" d={paths.land} pathLength={1} strokeWidth={0.5 * unit} />
          </g>
          {markers.map((marker, index) => {
            const radius = markerRadius(marker.count);
            const picked = isSelected(marker);
            const lit = marker.sites.some((site) => site.key === highlighted);
            return (
              <g
                key={marker.key}
                transform={`translate(${marker.x} ${marker.y}) scale(${unit})`}
                className={`pb-map-marker${picked ? ' is-selected' : ''}${lit ? ' is-lit' : ''}`}
                style={{ '--pb-map-i': index } as CSSProperties}
              >
                <g
                  className="pb-map-marker-body"
                  role="button"
                  tabIndex={0}
                  aria-label={markerLabel(marker)}
                  aria-pressed={picked}
                  data-testid="map-marker"
                  onClick={() => choose(marker)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    event.stopPropagation();
                    onInteract();
                    onSelect(marker.sites);
                  }}
                  onPointerEnter={() => setHovered(marker.key)}
                  onPointerLeave={() => setHovered((key) => (key === marker.key ? null : key))}
                  onFocus={() => setHovered(marker.key)}
                  onBlur={() => setHovered((key) => (key === marker.key ? null : key))}
                >
                  <circle className="pb-map-ripple" r={radius} stroke={colourOf(marker, colours)} />
                  <circle className="pb-map-halo" r={radius + 3} />
                  <circle className="pb-map-dot" r={radius} fill={colourOf(marker, colours)} />
                  {marker.count > 1 ? (
                    <>
                      <circle className="pb-map-core" r={radius - 3.5} />
                      <text className="pb-map-count" textAnchor="middle" dy="0.36em">
                        {marker.count}
                      </text>
                    </>
                  ) : null}
                </g>
              </g>
            );
          })}
        </svg>
        {tip !== undefined ? (
          <div
            className="pb-map-tip"
            role="presentation"
            style={{
              left: `${((tip.x - box.x) / box.width) * 100}%`,
              top: `${((tip.y - box.y) / box.height) * 100}%`,
              marginTop: -(markerRadius(tip.count) + 10),
            }}
          >
            <strong>
              {tip.sites.length === 1 && tip.sites[0] !== undefined
                ? siteLabel(tip.sites[0])
                : citiesText(tip.sites.length)}
            </strong>
            <span>{plural(tip.count, 'position')}</span>
          </div>
        ) : null}
        <div className="pb-map-zoom">
          <button type="button" aria-label="Zoom in" onClick={() => zoomBy(1.8)}>
            +
          </button>
          <button type="button" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.8)}>
            &minus;
          </button>
          <button
            type="button"
            aria-label="Show the whole world"
            className="pb-map-zoom-reset"
            onClick={() => {
              onInteract();
              flyTo(WORLD_VIEW, MOTION.draw);
            }}
          >
            World
          </button>
        </div>
        <p className={`pb-map-hint${hint ? ' is-shown' : ''}`} aria-hidden="true">
          Hold Ctrl and scroll to zoom
        </p>
      </div>
      <p className="pb-map-keys" id="pb-map-keys">
        Drag to move, double click to zoom in. With the map in focus: arrow keys move it, plus and
        minus zoom, 0 shows the whole world.
      </p>
    </div>
  );
}
