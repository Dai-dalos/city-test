import ClipperLib from 'clipper-lib'

// All geometry here is in metres on a flat local grid: x to the east, y to the north,
// with the kit centre at 0,0. Over 2 km the error is well under 0.1 %.
const R = 6371008.8
const RAD = Math.PI / 180

export const WALK_M_PER_MIN = 80 // 4.8 km/h
export const BAND_M = 25 // band on each side of a street
export const MAX_START_M = 100 // furthest a click may be from a walkable node
export const MINUTES = [5, 10, 15]
export const SHOP_MAX_MIN = 20 // the slider for shops goes from 1 to this

const SCALE = 100 // Clipper works in whole numbers: centimetres

export function makeProjection([lon0, lat0]) {
  const kx = Math.cos(lat0 * RAD) * R * RAD
  const ky = R * RAD
  return ([lon, lat]) => [(lon - lon0) * kx, (lat - lat0) * ky]
}

// Turn the raw files into metre-based structures once, at load time.
export function prepare({ kit, buildings, graph, zensus, shops }) {
  const project = makeProjection(kit.center)

  const nodes = graph.nodes.map((n) => ({ id: n.id, p: project([n.lon, n.lat]) }))
  const nodeIndex = new Map(nodes.map((n, i) => [n.id, i]))
  const edges = graph.edges
    .filter((e) => e.walkable)
    .map((e) => ({
      a: nodeIndex.get(e.from),
      b: nodeIndex.get(e.to),
      length: e.length,
      line: e.coords.map(project),
    }))
  const adjacency = nodes.map(() => [])
  edges.forEach((e, i) => {
    adjacency[e.a].push(i)
    adjacency[e.b].push(i)
  })
  // Only nodes on a walkable edge can be a start.
  const walkableNodes = nodes.map((_, i) => i).filter((i) => adjacency[i].length > 0)

  const houses = buildings.features.map((f) => {
    const rings = f.geometry.coordinates.map((ring) => {
      const pts = ring.map(project)
      const [first, last] = [pts[0], pts[pts.length - 1]]
      if (first[0] === last[0] && first[1] === last[1]) pts.pop()
      return pts
    })
    return {
      id: f.properties.id,
      height: f.properties.height,
      use: f.properties.use ?? 'undefined',
      rings,
      bbox: bboxOf(rings[0]),
    }
  })

  const cells = zensus.features.map((f) => {
    const ring = f.geometry.coordinates[0].map(project)
    ring.pop()
    if (signedArea(ring) < 0) ring.reverse()
    return {
      id: f.properties.id,
      population: f.properties.population,
      ring,
      area: signedArea(ring),
      bbox: bboxOf(ring),
    }
  })

  // Each shop is tied to the nearest point on a walkable street, and stands on the roof
  // of the building it lies in, if any, so its pin can be seen above the buildings.
  const shopList = shops.features.map((f) => {
    const p = project(f.geometry.coordinates)
    const house = houses.find((h) => insideBox(p, h.bbox) && insidePolygon(p, h.rings))
    return {
      ...f.properties,
      p,
      height: house?.height ?? 0,
      ...snapToStreet(edges, p),
    }
  })

  const [west, south, east, north] = kit.bbox
  const extent = { center: project([(west + east) / 2, (south + north) / 2]), size: kit.size_m }

  return { project, extent, nodes, edges, adjacency, walkableNodes, houses, cells, shops: shopList }
}

// The nearest point on any walkable edge: which edge, how far along it from end a
// (in the edge's own length in metres), and the straight distance from the street to the shop.
function snapToStreet(edges, p) {
  let best = { edge: -1, along: 0, offStreet: Infinity }
  edges.forEach((e, ei) => {
    let walked = 0
    const total = lineLength(e.line)
    for (let i = 1; i < e.line.length; i++) {
      const [a, b] = [e.line[i - 1], e.line[i]]
      const seg = Math.hypot(b[0] - a[0], b[1] - a[1])
      const t = seg === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / (seg * seg)))
      const d = Math.hypot(p[0] - (a[0] + t * (b[0] - a[0])), p[1] - (a[1] + t * (b[1] - a[1])))
      if (d < best.offStreet) best = { edge: ei, along: total === 0 ? 0 : ((walked + t * seg) / total) * e.length, offStreet: d }
      walked += seg
    }
  })
  return best
}

function lineLength(line) {
  let total = 0
  for (let i = 1; i < line.length; i++) total += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1])
  return total
}

// Walking time to every shop: along the network to the street point nearest the shop,
// from whichever end of that edge is quicker, plus the straight walk from the street.
function shopTimes(city, dist) {
  return city.shops
    .map((s, index) => {
      const e = city.edges[s.edge]
      const metres = Math.min(dist[e.a] + s.along, dist[e.b] + (e.length - s.along)) + s.offStreet
      return { index, metres, minutes: metres / WALK_M_PER_MIN }
    })
    .filter((t) => Number.isFinite(t.metres))
    .sort((a, b) => a.metres - b.metres)
}

// Everything the panel and the map need for one click.
export function computeReach(city, point) {
  const start = nearestNode(city, point)
  if (!start || start.distance > MAX_START_M) return { point, tooFar: true, startDistance: start?.distance }

  const dist = shortestDistances(city, start.index)
  const areas = MINUTES.map((minutes) => {
    const budget = minutes * WALK_M_PER_MIN
    const pieces = reachedPieces(city, dist, budget)
    const tree = bandShape(pieces)
    const paths = ClipperLib.Clipper.PolyTreeToPaths(tree)
    return {
      minutes,
      budget,
      shapes: treeToShapes(tree),
      buildings: buildingsTouching(city.houses, pieces),
      ...residents(city.cells, paths),
    }
  })
  return { point, start: city.nodes[start.index].p, startDistance: start.distance, areas, shops: shopTimes(city, dist) }
}

function nearestNode(city, [x, y]) {
  let best = null
  for (const i of city.walkableNodes) {
    const [nx, ny] = city.nodes[i].p
    const d = Math.hypot(nx - x, ny - y)
    if (!best || d < best.distance) best = { index: i, distance: d }
  }
  return best
}

// Dijkstra over the walkable edges, using their length in metres.
// With under a thousand nodes a plain array scan is fast enough.
function shortestDistances(city, source) {
  const n = city.nodes.length
  const dist = new Float64Array(n).fill(Infinity)
  const done = new Uint8Array(n)
  dist[source] = 0
  for (;;) {
    let u = -1
    for (let i = 0; i < n; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i
    if (u < 0) break
    done[u] = 1
    for (const ei of city.adjacency[u]) {
      const e = city.edges[ei]
      const v = e.a === u ? e.b : e.a
      const d = dist[u] + e.length
      if (d < dist[v]) dist[v] = d
    }
  }
  return dist
}

// The parts of every edge you can reach within the budget, as polylines in metres.
// An edge is walked in from either end; if the two parts meet, the whole edge is reached.
function reachedPieces(city, dist, budget) {
  const pieces = []
  for (const e of city.edges) {
    const fromA = Math.max(0, budget - dist[e.a])
    const fromB = Math.max(0, budget - dist[e.b])
    if (fromA + fromB >= e.length) {
      pieces.push(e.line)
      continue
    }
    if (fromA > 0) pieces.push(cutLine(e.line, fromA / e.length))
    if (fromB > 0) pieces.push(cutLine([...e.line].reverse(), fromB / e.length))
  }
  return pieces
}

// The start of a line up to a share t (0..1) of its length.
function cutLine(line, t) {
  const lengths = []
  let total = 0
  for (let i = 1; i < line.length; i++) {
    const l = Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1])
    lengths.push(l)
    total += l
  }
  let left = t * total
  const out = [line[0]]
  for (let i = 1; i < line.length; i++) {
    if (left <= lengths[i - 1]) {
      const s = lengths[i - 1] === 0 ? 0 : left / lengths[i - 1]
      const [ax, ay] = line[i - 1]
      const [bx, by] = line[i]
      out.push([ax + (bx - ax) * s, ay + (by - ay) * s])
      return out
    }
    left -= lengths[i - 1]
    out.push(line[i])
  }
  return out
}

// A 25 m band on each side of every piece, with round ends, joined into one shape.
function bandShape(pieces) {
  const offset = new ClipperLib.ClipperOffset(2, 0.1 * SCALE)
  for (const piece of pieces) {
    offset.AddPath(toPath(piece), ClipperLib.JoinType.jtRound, ClipperLib.EndType.etOpenRound)
  }
  const tree = new ClipperLib.PolyTree()
  offset.Execute(tree, BAND_M * SCALE)
  return tree
}

// Outlines with their holes, in metres, ready to draw.
function treeToShapes(tree) {
  const shapes = []
  const visit = (node) => {
    for (const outer of node.Childs()) {
      shapes.push({
        outer: fromPath(outer.Contour()),
        holes: outer.Childs().map((h) => fromPath(h.Contour())),
      })
      for (const hole of outer.Childs()) visit(hole)
    }
  }
  visit(tree)
  return shapes
}

// A building touches the area when its footprint comes within 25 m of a reached piece.
// That is the same as touching the band, without the rounding of the drawn outline.
function buildingsTouching(houses, pieces) {
  const GRID = 50
  const grid = new Map()
  const segments = []
  for (const piece of pieces) {
    for (let i = 1; i < piece.length; i++) {
      const s = [piece[i - 1], piece[i]]
      const si = segments.push(s) - 1
      const [x0, x1] = [Math.min(s[0][0], s[1][0]), Math.max(s[0][0], s[1][0])]
      const [y0, y1] = [Math.min(s[0][1], s[1][1]), Math.max(s[0][1], s[1][1])]
      for (let gx = Math.floor(x0 / GRID); gx <= Math.floor(x1 / GRID); gx++)
        for (let gy = Math.floor(y0 / GRID); gy <= Math.floor(y1 / GRID); gy++) {
          const key = gx + ',' + gy
          if (!grid.has(key)) grid.set(key, [])
          grid.get(key).push(si)
        }
    }
  }

  const touched = new Set()
  houses.forEach((h, hi) => {
    const [x0, y0, x1, y1] = h.bbox
    const seen = new Set()
    for (let gx = Math.floor((x0 - BAND_M) / GRID); gx <= Math.floor((x1 + BAND_M) / GRID); gx++)
      for (let gy = Math.floor((y0 - BAND_M) / GRID); gy <= Math.floor((y1 + BAND_M) / GRID); gy++) {
        for (const si of grid.get(gx + ',' + gy) ?? []) {
          if (seen.has(si)) continue
          seen.add(si)
          if (segmentToPolygon(segments[si], h.rings) <= BAND_M) {
            touched.add(hi)
            return
          }
        }
      }
  })
  return touched
}

function segmentToPolygon([p, q], rings) {
  if (insidePolygon(p, rings)) return 0
  let best = Infinity
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]
      const b = ring[(i + 1) % ring.length]
      best = Math.min(best, segmentToSegment(p, q, a, b))
      if (best === 0) return 0
    }
  }
  return best
}

function insidePolygon(pt, rings) {
  let inside = false
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]
      const [xj, yj] = ring[j]
      if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside
    }
  }
  return inside
}

function segmentToSegment(p, q, a, b) {
  if (segmentsCross(p, q, a, b)) return 0
  return Math.min(pointToSegment(p, a, b), pointToSegment(q, a, b), pointToSegment(a, p, q), pointToSegment(b, p, q))
}

function segmentsCross(p, q, a, b) {
  const cross = (o, u, v) => (u[0] - o[0]) * (v[1] - o[1]) - (u[1] - o[1]) * (v[0] - o[0])
  const d1 = cross(a, b, p)
  const d2 = cross(a, b, q)
  const d3 = cross(p, q, a)
  const d4 = cross(p, q, b)
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}

function pointToSegment([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax
  const dy = by - ay
  const l2 = dx * dx + dy * dy
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

// Residents: for each census cell that overlaps the area, its population times the share
// of the cell inside the area. Cells with no published figure are counted, not summed.
// The band's outlines run one way and its holes the other, so adding up the signed area
// of each outline clipped to the (convex) cell gives the area of the band inside the cell.
function residents(cells, areaPaths) {
  const rings = areaPaths.map((path) => {
    const ring = fromPath(path)
    return { ring, bbox: bboxOf(ring) }
  })
  let sum = 0
  let unknownCells = 0
  let cellsOverlapping = 0
  for (const cell of cells) {
    let area = 0
    for (const r of rings) {
      if (bboxesOverlap(r.bbox, cell.bbox)) area += signedArea(clipToConvex(r.ring, cell.ring))
    }
    if (area <= 1e-6) continue
    cellsOverlapping++
    if (cell.population == null) unknownCells++
    else sum += cell.population * Math.min(1, area / cell.area)
  }
  return { residents: Math.round(sum / 10) * 10, unknownCells, cellsOverlapping }
}

// Sutherland–Hodgman: the part of a ring inside a convex, anticlockwise polygon.
function clipToConvex(ring, convex) {
  let out = ring
  for (let i = 0; i < convex.length && out.length; i++) {
    const [ax, ay] = convex[i]
    const [bx, by] = convex[(i + 1) % convex.length]
    const side = ([x, y]) => (bx - ax) * (y - ay) - (by - ay) * (x - ax)
    const input = out
    out = []
    for (let j = 0; j < input.length; j++) {
      const p = input[j]
      const q = input[(j + 1) % input.length]
      const sp = side(p)
      const sq = side(q)
      if (sp >= 0) out.push(p)
      if ((sp >= 0) !== (sq >= 0)) {
        const t = sp / (sp - sq)
        out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t])
      }
    }
  }
  return out
}

function signedArea(ring) {
  let a = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]
  return a / 2
}

function toPath(points) {
  return points.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }))
}

function fromPath(path) {
  return path.map((p) => [p.X / SCALE, p.Y / SCALE])
}

function bboxOf(points) {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const [x, y] of points) {
    if (x < x0) x0 = x
    if (y < y0) y0 = y
    if (x > x1) x1 = x
    if (y > y1) y1 = y
  }
  return [x0, y0, x1, y1]
}

function insideBox([x, y], [x0, y0, x1, y1]) {
  return x >= x0 && x <= x1 && y >= y0 && y <= y1
}

function bboxesOverlap(a, b) {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]
}
