/** Vite's classic-worker import (`import WorkerFactory from './x?worker'`). */
declare module '*?worker' {
  const WorkerFactory: new () => Worker
  export default WorkerFactory
}
