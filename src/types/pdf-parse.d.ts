// pdf-parse se importa por su archivo de adentro (el principal corre una prueba al cargarse)
declare module "pdf-parse/lib/pdf-parse.js" {
  const leer: (archivo: Buffer) => Promise<{ text: string; numpages: number }>;
  export default leer;
}
