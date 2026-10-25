import { useEffect, useMemo, useRef } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { BACKGROUND, GROUND, REACH_COLORS, SHOP_COLOR, SHOP_FAINT, STREET, USE_COLORS } from './palette.js'

// The scene uses x to the east, y up and z to the south, so a point [east, north] in metres
// sits at (east, 0, -north). Footprints are drawn in the x/y plane and then tipped flat.
const toFlat = (geometry) => geometry.rotateX(-Math.PI / 2)

export default function City({ city, reach, onPick, shownShops, hoveredShop }) {
  const span = Math.max(...city.extent.size)
  return (
    <Canvas
      camera={{ position: [0, span * 0.7, span * 0.75], fov: 40, near: 5, far: span * 10 }}
      gl={{ antialias: true }}
      style={{ background: BACKGROUND }}
    >
      <hemisphereLight args={['#ffffff', '#b8b2a6', 2.2]} />
      <directionalLight position={[-600, 1000, 400]} intensity={1.6} />
      <Ground extent={city.extent} onPick={onPick} />
      <ReachAreas reach={reach} />
      <Streets edges={city.edges} />
      <Buildings houses={city.houses} reach={reach} onPick={onPick} />
      <ShopPins shops={city.shops} shown={shownShops} hovered={hoveredShop} />
      {reach && <Marker reach={reach} />}
      <OrbitControls makeDefault target={[0, 0, 0]} maxPolarAngle={Math.PI * 0.47} minDistance={60} maxDistance={span * 3} />
    </Canvas>
  )
}

// A click is a pick only if the mouse hardly moved; otherwise it was a drag to orbit or pan.
function pickHandler(onPick) {
  return (e) => {
    if (e.delta > 4) return
    e.stopPropagation()
    onPick([e.point.x, -e.point.z])
  }
}

function Ground({ extent, onPick }) {
  const [w, h] = extent.size
  const margin = 300
  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[extent.center[0], 0, -extent.center[1]]}
      renderOrder={0}
      onClick={pickHandler(onPick)}
    >
      <planeGeometry args={[w + margin * 2, h + margin * 2]} />
      <meshBasicMaterial color={GROUND} depthWrite={false} />
    </mesh>
  )
}

// The flat layers (ground, areas, streets) are drawn first and in a fixed order, without
// writing depth, so they never flicker against each other. Buildings are drawn over them.
function ReachAreas({ reach }) {
  const layers = useMemo(() => {
    if (!reach?.areas) return []
    return [...reach.areas].reverse().map((area, i) => {
      const shapes = area.shapes.map(({ outer, holes }) => {
        const shape = new THREE.Shape(outer.map(([x, y]) => new THREE.Vector2(x, y)))
        shape.holes = holes.map((hole) => new THREE.Path(hole.map(([x, y]) => new THREE.Vector2(x, y))))
        return shape
      })
      return { minutes: area.minutes, order: i + 1, geometry: toFlat(new THREE.ShapeGeometry(shapes)) }
    })
  }, [reach])

  useEffect(() => () => layers.forEach((l) => l.geometry.dispose()), [layers])

  return layers.map((l) => (
    <mesh key={l.minutes} geometry={l.geometry} renderOrder={l.order}>
      <meshBasicMaterial color={REACH_COLORS[l.minutes]} depthWrite={false} />
    </mesh>
  ))
}

function Streets({ edges }) {
  const geometry = useMemo(() => {
    const positions = []
    for (const e of edges) {
      for (let i = 1; i < e.line.length; i++) {
        const [ax, ay] = e.line[i - 1]
        const [bx, by] = e.line[i]
        positions.push(ax, 0, -ay, bx, 0, -by)
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    return g
  }, [edges])

  return (
    <lineSegments geometry={geometry} renderOrder={4}>
      <lineBasicMaterial color={STREET} depthWrite={false} transparent opacity={0.8} />
    </lineSegments>
  )
}

// All buildings in one mesh. Each building keeps its range of vertices, so the colours
// can be changed in place when an area is reached, without rebuilding the mesh.
function Buildings({ houses, reach, onPick }) {
  const { geometry, ranges } = useMemo(() => {
    const parts = []
    const ranges = []
    let start = 0
    for (const h of houses) {
      const [outer, ...holes] = h.rings
      const shape = new THREE.Shape(outer.map(([x, y]) => new THREE.Vector2(x, y)))
      shape.holes = holes.map((ring) => new THREE.Path(ring.map(([x, y]) => new THREE.Vector2(x, y))))
      const g = new THREE.ExtrudeGeometry(shape, { depth: h.height, bevelEnabled: false })
      g.deleteAttribute('uv')
      toFlat(g)
      const count = g.attributes.position.count
      ranges.push([start, count])
      start += count
      parts.push(g)
    }
    const geometry = mergeGeometries(parts)
    parts.forEach((g) => g.dispose())
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(start * 3), 3))
    return { geometry, ranges }
  }, [houses])

  useEffect(() => {
    const colors = geometry.attributes.color
    const shade = new Map()
    if (reach?.areas) {
      // Paint from 15 down to 5 minutes, so each building ends up with the shortest walk.
      for (const area of [...reach.areas].reverse()) {
        for (const i of area.buildings) shade.set(i, area.minutes)
      }
    }
    const color = new THREE.Color()
    houses.forEach((h, i) => {
      const minutes = shade.get(i)
      color.set(minutes ? REACH_COLORS[minutes] : USE_COLORS[h.use] ?? USE_COLORS.undefined)
      const [first, count] = ranges[i]
      for (let v = first; v < first + count; v++) colors.setXYZ(v, color.r, color.g, color.b)
    })
    colors.needsUpdate = true
  }, [geometry, ranges, houses, reach])

  return (
    <mesh geometry={geometry} renderOrder={5} onClick={pickHandler(onPick)}>
      <meshLambertMaterial vertexColors />
    </mesh>
  )
}

// One small ball per shop, a few metres above its roof. Shops in the list are blue and
// stand on a stem down to the ground; the others are small and grey; the hovered one is large.
const PIN_ABOVE_M = 6

function ShopPins({ shops, shown, hovered }) {
  const ref = useRef()
  const stems = useMemo(() => {
    const positions = []
    for (const t of shown) {
      const s = shops[t.index]
      positions.push(s.p[0], 0, -s.p[1], s.p[0], s.height + PIN_ABOVE_M, -s.p[1])
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    return g
  }, [shops, shown])

  useEffect(() => () => stems.dispose(), [stems])

  useEffect(() => {
    const mesh = ref.current
    const firstColors = !mesh.instanceColor
    const inList = new Set(shown.map((t) => t.index))
    const m = new THREE.Matrix4()
    const color = new THREE.Color()
    shops.forEach((s, i) => {
      const size = !inList.has(i) ? 0.7 : i === hovered ? 4 : 2
      m.makeScale(size, size, size).setPosition(s.p[0], s.height + PIN_ABOVE_M, -s.p[1])
      mesh.setMatrixAt(i, m)
      mesh.setColorAt(i, color.set(inList.has(i) ? SHOP_COLOR : SHOP_FAINT))
    })
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    // The material has to be rebuilt once to pick up the colours per pin.
    if (firstColors && mesh.instanceColor) mesh.material.needsUpdate = true
  }, [shops, shown, hovered])

  return (
    <>
      <lineSegments geometry={stems} renderOrder={6}>
        <lineBasicMaterial color={SHOP_COLOR} />
      </lineSegments>
      <instancedMesh ref={ref} args={[undefined, undefined, shops.length]} renderOrder={6}>
        <sphereGeometry args={[3, 16, 12]} />
        <meshBasicMaterial />
      </instancedMesh>
    </>
  )
}

function Marker({ reach }) {
  const [x, y] = reach.start ?? reach.point
  return (
    <mesh position={[x, 12, -y]} renderOrder={6}>
      <sphereGeometry args={[6, 24, 16]} />
      <meshBasicMaterial color={reach.tooFar ? '#555' : '#3a1606'} />
    </mesh>
  )
}
