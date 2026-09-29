--
-- PostgreSQL database dump
--

-- Dumped from database version 15.12
-- Dumped by pg_dump version 16.8

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: estado_cierre; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.estado_cierre AS ENUM (
    'ABIERTA',
    'CERRADA'
);


--
-- Name: estado_cuenta; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.estado_cuenta AS ENUM (
    'PENDIENTE',
    'ABONADA',
    'PAGADA',
    'VENCIDA'
);


--
-- Name: estado_cuenta_corriente; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.estado_cuenta_corriente AS ENUM (
    'DISPONIBLE',
    'BLOQUEADA',
    'CERRADA'
);


--
-- Name: estado_referencia; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.estado_referencia AS ENUM (
    'REGISTRADA',
    'BLOQUEADA',
    'CONFIRMADA',
    'RECHAZADA'
);


--
-- Name: estado_transaccion; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.estado_transaccion AS ENUM (
    'PENDIENTE',
    'BLOQUEADA',
    'CONFIRMADA',
    'RECHAZADA',
    'ANULADA'
);


--
-- Name: rol_usuario; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.rol_usuario AS ENUM (
    'ADMIN',
    'ASESOR',
    'CAJERO',
    'OPERADOR'
);


--
-- Name: tipo_caja; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.tipo_caja AS ENUM (
    'FISICA',
    'FUERTE',
    'BANCO'
);


--
-- Name: tipo_movimiento; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.tipo_movimiento AS ENUM (
    'INGRESO',
    'EGRESO'
);


--
-- Name: tipo_movimiento_cc; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.tipo_movimiento_cc AS ENUM (
    'COMPRA',
    'VENTA',
    'ABONO',
    'CARGO',
    'AJUSTE'
);


--
-- Name: tipo_tercero; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.tipo_tercero AS ENUM (
    'CLIENTE',
    'PROVEEDOR',
    'MIXTO'
);


--
-- Name: tipo_transaccion; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.tipo_transaccion AS ENUM (
    'COMPRA_DIVISA',
    'VENTA_DIVISA',
    'DEPOSITO',
    'RETIRO',
    'TRANSFERENCIA_INTERNA',
    'ABONO_CXC',
    'ABONO_CXP'
);


--
-- Name: set_actualizado_en(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_actualizado_en() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.actualizado_en = now();
  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: abonos_cuenta; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.abonos_cuenta (
    id integer NOT NULL,
    cuenta_por_cobrar_id integer,
    cuenta_por_pagar_id integer,
    monto numeric(20,4) NOT NULL,
    fecha timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT abonos_cuenta_check CHECK ((num_nonnulls(cuenta_por_cobrar_id, cuenta_por_pagar_id) = 1)),
    CONSTRAINT abonos_cuenta_monto_check CHECK ((monto > (0)::numeric))
);


--
-- Name: abonos_cuenta_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.abonos_cuenta_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: abonos_cuenta_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.abonos_cuenta_id_seq OWNED BY public.abonos_cuenta.id;


--
-- Name: cajas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cajas (
    id integer NOT NULL,
    nombre text NOT NULL,
    tipo public.tipo_caja DEFAULT 'FISICA'::public.tipo_caja NOT NULL,
    activo boolean DEFAULT true NOT NULL
);


--
-- Name: cajas_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cajas_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cajas_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cajas_id_seq OWNED BY public.cajas.id;


--
-- Name: canales_cuenta_corriente; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.canales_cuenta_corriente (
    id integer NOT NULL,
    nombre text NOT NULL,
    activo boolean DEFAULT true NOT NULL
);


--
-- Name: canales_cuenta_corriente_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.canales_cuenta_corriente_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: canales_cuenta_corriente_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.canales_cuenta_corriente_id_seq OWNED BY public.canales_cuenta_corriente.id;


--
-- Name: categorias_movimiento; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.categorias_movimiento (
    id integer NOT NULL,
    nombre text NOT NULL,
    activo boolean DEFAULT true NOT NULL
);


--
-- Name: categorias_movimiento_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.categorias_movimiento_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: categorias_movimiento_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.categorias_movimiento_id_seq OWNED BY public.categorias_movimiento.id;


--
-- Name: cierres_caja; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cierres_caja (
    id integer NOT NULL,
    caja_id integer NOT NULL,
    usuario_id integer NOT NULL,
    fecha_apertura timestamp with time zone NOT NULL,
    fecha_cierre timestamp with time zone,
    saldo_inicial numeric(20,4) NOT NULL,
    saldo_esperado numeric(20,4),
    saldo_real numeric(20,4),
    diferencia numeric(20,4),
    estado public.estado_cierre DEFAULT 'ABIERTA'::public.estado_cierre NOT NULL,
    moneda_id integer NOT NULL
);


--
-- Name: cierres_caja_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cierres_caja_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cierres_caja_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cierres_caja_id_seq OWNED BY public.cierres_caja.id;


--
-- Name: cotizaciones_detalle; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cotizaciones_detalle (
    id integer NOT NULL,
    moneda_id integer NOT NULL,
    tipo text NOT NULL,
    etiqueta text NOT NULL,
    valor numeric(20,4),
    ajuste_pct numeric(6,2),
    vigente_desde timestamp with time zone DEFAULT now() NOT NULL,
    creado_por_id integer NOT NULL,
    categoria text DEFAULT 'EFECTIVO'::text NOT NULL,
    CONSTRAINT cotizaciones_detalle_categoria_check CHECK ((categoria = ANY (ARRAY['EFECTIVO'::text, 'GIRO'::text]))),
    CONSTRAINT cotizaciones_detalle_check CHECK ((num_nonnulls(valor, ajuste_pct) = 1)),
    CONSTRAINT cotizaciones_detalle_tipo_check CHECK ((tipo = ANY (ARRAY['COMPRA'::text, 'VENTA'::text])))
);


--
-- Name: cotizaciones_detalle_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cotizaciones_detalle_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cotizaciones_detalle_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cotizaciones_detalle_id_seq OWNED BY public.cotizaciones_detalle.id;


--
-- Name: cuentas_corrientes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cuentas_corrientes (
    id integer NOT NULL,
    tercero_id integer NOT NULL,
    canal_id integer NOT NULL,
    moneda_id integer NOT NULL,
    saldo_actual numeric(20,4) DEFAULT 0 NOT NULL,
    activo boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    estado public.estado_cuenta_corriente DEFAULT 'DISPONIBLE'::public.estado_cuenta_corriente NOT NULL
);


--
-- Name: cuentas_corrientes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cuentas_corrientes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cuentas_corrientes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cuentas_corrientes_id_seq OWNED BY public.cuentas_corrientes.id;


--
-- Name: cuentas_por_cobrar; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cuentas_por_cobrar (
    id integer NOT NULL,
    tercero_id integer NOT NULL,
    moneda_id integer NOT NULL,
    monto_original numeric(20,4) NOT NULL,
    saldo_pendiente numeric(20,4) NOT NULL,
    estado public.estado_cuenta DEFAULT 'PENDIENTE'::public.estado_cuenta NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cuentas_por_cobrar_monto_original_check CHECK ((monto_original > (0)::numeric)),
    CONSTRAINT cuentas_por_cobrar_saldo_pendiente_check CHECK ((saldo_pendiente >= (0)::numeric))
);


--
-- Name: cuentas_por_cobrar_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cuentas_por_cobrar_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cuentas_por_cobrar_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cuentas_por_cobrar_id_seq OWNED BY public.cuentas_por_cobrar.id;


--
-- Name: cuentas_por_pagar; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cuentas_por_pagar (
    id integer NOT NULL,
    tercero_id integer NOT NULL,
    moneda_id integer NOT NULL,
    monto_original numeric(20,4) NOT NULL,
    saldo_pendiente numeric(20,4) NOT NULL,
    estado public.estado_cuenta DEFAULT 'PENDIENTE'::public.estado_cuenta NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cuentas_por_pagar_monto_original_check CHECK ((monto_original > (0)::numeric)),
    CONSTRAINT cuentas_por_pagar_saldo_pendiente_check CHECK ((saldo_pendiente >= (0)::numeric))
);


--
-- Name: cuentas_por_pagar_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cuentas_por_pagar_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cuentas_por_pagar_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cuentas_por_pagar_id_seq OWNED BY public.cuentas_por_pagar.id;


--
-- Name: metodos_pago; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.metodos_pago (
    id integer NOT NULL,
    nombre text NOT NULL,
    activo boolean DEFAULT true NOT NULL
);


--
-- Name: metodos_pago_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.metodos_pago_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: metodos_pago_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.metodos_pago_id_seq OWNED BY public.metodos_pago.id;


--
-- Name: monedas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.monedas (
    id integer NOT NULL,
    codigo text NOT NULL,
    nombre text NOT NULL,
    simbolo text NOT NULL,
    decimales integer DEFAULT 2 NOT NULL,
    activo boolean DEFAULT true NOT NULL
);


--
-- Name: monedas_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.monedas_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: monedas_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.monedas_id_seq OWNED BY public.monedas.id;


--
-- Name: movimientos_caja; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.movimientos_caja (
    id integer NOT NULL,
    caja_id integer NOT NULL,
    transaccion_id integer,
    moneda_id integer NOT NULL,
    metodo_pago_id integer,
    tipo public.tipo_movimiento NOT NULL,
    monto numeric(20,4) NOT NULL,
    saldo_anterior numeric(20,4) NOT NULL,
    saldo_nuevo numeric(20,4) NOT NULL,
    usuario_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    categoria_id integer,
    CONSTRAINT movimientos_caja_monto_check CHECK ((monto > (0)::numeric))
);


--
-- Name: movimientos_caja_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.movimientos_caja_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: movimientos_caja_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.movimientos_caja_id_seq OWNED BY public.movimientos_caja.id;


--
-- Name: movimientos_cuenta_corriente; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.movimientos_cuenta_corriente (
    id integer NOT NULL,
    cuenta_corriente_id integer NOT NULL,
    fecha timestamp with time zone DEFAULT now() NOT NULL,
    descripcion text,
    tipo public.tipo_movimiento_cc NOT NULL,
    cantidad_base numeric(20,8),
    moneda_base_id integer,
    tasa numeric(20,8),
    monto numeric(20,4) NOT NULL,
    saldo_anterior numeric(20,4) NOT NULL,
    saldo_nuevo numeric(20,4) NOT NULL,
    transaccion_id integer,
    usuario_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    categoria_id integer
);


--
-- Name: movimientos_cuenta_corriente_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.movimientos_cuenta_corriente_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: movimientos_cuenta_corriente_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.movimientos_cuenta_corriente_id_seq OWNED BY public.movimientos_cuenta_corriente.id;


--
-- Name: referencias; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.referencias (
    id integer NOT NULL,
    codigo text NOT NULL,
    banco_origen text,
    estado public.estado_referencia DEFAULT 'REGISTRADA'::public.estado_referencia NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: referencias_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.referencias_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: referencias_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.referencias_id_seq OWNED BY public.referencias.id;


--
-- Name: saldos_caja; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.saldos_caja (
    id integer NOT NULL,
    caja_id integer NOT NULL,
    moneda_id integer NOT NULL,
    monto numeric(20,4) DEFAULT 0 NOT NULL,
    actualizado_en timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: saldos_caja_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.saldos_caja_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: saldos_caja_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.saldos_caja_id_seq OWNED BY public.saldos_caja.id;


--
-- Name: tasas_cambio; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tasas_cambio (
    id integer NOT NULL,
    moneda_origen_id integer NOT NULL,
    moneda_destino_id integer NOT NULL,
    valor numeric(20,8) NOT NULL,
    vigente_desde timestamp with time zone DEFAULT now() NOT NULL,
    creado_por_id integer NOT NULL,
    CONSTRAINT tasas_cambio_check CHECK ((moneda_origen_id <> moneda_destino_id)),
    CONSTRAINT tasas_cambio_valor_check CHECK ((valor > (0)::numeric))
);


--
-- Name: tasas_cambio_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tasas_cambio_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tasas_cambio_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tasas_cambio_id_seq OWNED BY public.tasas_cambio.id;


--
-- Name: terceros; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.terceros (
    id integer NOT NULL,
    nombre text NOT NULL,
    identificacion text,
    telefono text,
    tipo public.tipo_tercero NOT NULL,
    activo boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: terceros_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.terceros_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: terceros_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.terceros_id_seq OWNED BY public.terceros.id;


--
-- Name: transacciones; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transacciones (
    id integer NOT NULL,
    tipo public.tipo_transaccion NOT NULL,
    estado public.estado_transaccion DEFAULT 'PENDIENTE'::public.estado_transaccion NOT NULL,
    tercero_id integer,
    caja_id integer NOT NULL,
    moneda_origen_id integer NOT NULL,
    monto_origen numeric(20,4) NOT NULL,
    moneda_destino_id integer,
    monto_destino numeric(20,4),
    tasa_cambio_id integer,
    metodo_pago_id integer,
    referencia_id integer,
    usuario_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    confirmada_en timestamp with time zone,
    confirmado_por_id integer,
    motivo_rechazo text,
    caja_destino_id integer,
    cotizacion_detalle_id integer,
    tasa_aplicada numeric(20,8),
    operacion_calculo text,
    CONSTRAINT transacciones_monto_origen_check CHECK ((monto_origen > (0)::numeric)),
    CONSTRAINT transacciones_operacion_calculo_check CHECK ((operacion_calculo = ANY (ARRAY['MULTIPLICACION'::text, 'DIVISION'::text])))
);


--
-- Name: transacciones_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.transacciones_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: transacciones_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.transacciones_id_seq OWNED BY public.transacciones.id;


--
-- Name: trm_colombia_historico; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trm_colombia_historico (
    fecha date NOT NULL,
    valor numeric(12,4) NOT NULL,
    fuente text DEFAULT 'Superfinanciera (vía DolarApi)'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: usuarios; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.usuarios (
    id integer NOT NULL,
    nombre text NOT NULL,
    email text NOT NULL,
    password_hash text NOT NULL,
    rol public.rol_usuario NOT NULL,
    activo boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: usuarios_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.usuarios_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: usuarios_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.usuarios_id_seq OWNED BY public.usuarios.id;


--
-- Name: whatsapp_configuracion; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_configuracion (
    id integer NOT NULL,
    respuesta_automatica_activa boolean DEFAULT false NOT NULL,
    mensaje_automatico text DEFAULT 'Gracias por escribirnos. Un asesor te va a atender en breve. 🙌'::text NOT NULL,
    actualizado_en timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: whatsapp_configuracion_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.whatsapp_configuracion_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: whatsapp_configuracion_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.whatsapp_configuracion_id_seq OWNED BY public.whatsapp_configuracion.id;


--
-- Name: whatsapp_mensajes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_mensajes (
    id integer NOT NULL,
    telefono text NOT NULL,
    nombre_contacto text,
    mensaje text NOT NULL,
    monto_detectado numeric(20,4),
    moneda_detectada_id integer,
    tercero_id integer,
    estado text DEFAULT 'SIN_REVISAR'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT whatsapp_mensajes_estado_check CHECK ((estado = ANY (ARRAY['SIN_REVISAR'::text, 'CONVERTIDO'::text, 'DESCARTADO'::text])))
);


--
-- Name: whatsapp_mensajes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.whatsapp_mensajes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: whatsapp_mensajes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.whatsapp_mensajes_id_seq OWNED BY public.whatsapp_mensajes.id;


--
-- Name: abonos_cuenta id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.abonos_cuenta ALTER COLUMN id SET DEFAULT nextval('public.abonos_cuenta_id_seq'::regclass);


--
-- Name: cajas id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cajas ALTER COLUMN id SET DEFAULT nextval('public.cajas_id_seq'::regclass);


--
-- Name: canales_cuenta_corriente id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canales_cuenta_corriente ALTER COLUMN id SET DEFAULT nextval('public.canales_cuenta_corriente_id_seq'::regclass);


--
-- Name: categorias_movimiento id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categorias_movimiento ALTER COLUMN id SET DEFAULT nextval('public.categorias_movimiento_id_seq'::regclass);


--
-- Name: cierres_caja id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cierres_caja ALTER COLUMN id SET DEFAULT nextval('public.cierres_caja_id_seq'::regclass);


--
-- Name: cotizaciones_detalle id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cotizaciones_detalle ALTER COLUMN id SET DEFAULT nextval('public.cotizaciones_detalle_id_seq'::regclass);


--
-- Name: cuentas_corrientes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cuentas_corrientes ALTER COLUMN id SET DEFAULT nextval('public.cuentas_corrientes_id_seq'::regclass);


--
-- Name: cuentas_por_cobrar id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cuentas_por_cobrar ALTER COLUMN id SET DEFAULT nextval('public.cuentas_por_cobrar_id_seq'::regclass);


--
-- Name: cuentas_por_pagar id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cuentas_por_pagar ALTER COLUMN id SET DEFAULT nextval('public.cuentas_por_pagar_id_seq'::regclass);


--
-- Name: metodos_pago id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metodos_pago ALTER COLUMN id SET DEFAULT nextval('public.metodos_pago_id_seq'::regclass);


--
-- Name: monedas id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monedas ALTER COLUMN id SET DEFAULT nextval('public.monedas_id_seq'::regclass);


--
-- Name: movimientos_caja id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movimientos_caja ALTER COLUMN id SET DEFAULT nextval('public.movimientos_caja_id_seq'::regclass);


--
-- Name: movimientos_cuenta_corriente id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movimientos_cuenta_corriente ALTER COLUMN id SET DEFAULT nextval('public.movimientos_cuenta_corriente_id_seq'::regclass);


--
-- Name: referencias id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referencias ALTER COLUMN id SET DEFAULT nextval('public.referencias_id_seq'::regclass);


--
-- Name: saldos_caja id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saldos_caja ALTER COLUMN id SET DEFAULT nextval('public.saldos_caja_id_seq'::regclass);


--
-- Name: tasas_cambio id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasas_cambio ALTER COLUMN id SET DEFAULT nextval('public.tasas_cambio_id_seq'::regclass);


--
-- Name: terceros id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.terceros ALTER COLUMN id SET DEFAULT nextval('public.terceros_id_seq'::regclass);


--
-- Name: transacciones id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transacciones ALTER COLUMN id SET DEFAULT nextval('public.transacciones_id_seq'::regclass);


--
-- Name: usuarios id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usuarios ALTER COLUMN id SET DEFAULT nextval('public.usuarios_id_seq'::regclass);


--
-- Name: whatsapp_configuracion id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_configuracion ALTER COLUMN id SET DEFAULT nextval('public.whatsapp_configuracion_id_seq'::regclass);


--
-- Name: whatsapp_mensajes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_mensajes ALTER COLUMN id SET DEFAULT nextval('public.whatsapp_mensajes_id_seq'::regclass);


--
-- Name: abonos_cuenta abonos_cuenta_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.abonos_cuenta
    ADD CONSTRAINT abonos_cuenta_pkey PRIMARY KEY (id);


--
-- Name: cajas cajas_nombre_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cajas
    ADD CONSTRAINT cajas_nombre_key UNIQUE (nombre);


--
-- Name: cajas cajas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cajas
    ADD CONSTRAINT cajas_pkey PRIMARY KEY (id);


--
-- Name: canales_cuenta_corriente canales_cuenta_corriente_nombre_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canales_cuenta_corriente
    ADD CONSTRAINT canales_cuenta_corriente_nombre_key UNIQUE (nombre);


--
-- Name: canales_cuenta_corriente canales_cuenta_corriente_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canales_cuenta_corriente
    ADD CONSTRAINT canales_cuenta_corriente_pkey PRIMARY KEY (id);


--
-- Name: categorias_movimiento categorias_movimiento_nombre_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categorias_movimiento
    ADD CONSTRAINT categorias_movimiento_nombre_key UNIQUE (nombre);


--
-- Name: categorias_movimiento categorias_movimiento_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categorias_movimiento
    ADD CONSTRAINT categorias_movimiento_pkey PRIMARY KEY (id);


--
-- Name: cierres_caja cierres_caja_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cierres_caja
    ADD CONSTRAINT cierres_caja_pkey PRIMARY KEY (id);


--
-- Name: cotizaciones_detalle cotizaciones_detalle_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cotizaciones_detalle
    ADD CONSTRAINT cotizaciones_detalle_pkey PRIMARY KEY (id);


--
-- Name: cuentas_corrientes cuentas_corrientes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cuentas_corrientes
    ADD CONSTRAINT cuentas_corrientes_pkey PRIMARY KEY (id);


--
-- Name: cuentas_corrientes cuentas_corrientes_tercero_id_canal_id_moneda_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cuentas_corrientes
    ADD CONSTRAINT cuentas_corrientes_tercero_id_canal_id_moneda_id_key UNIQUE (tercero_id, canal_id, moneda_id);


--
-- Name: cuentas_por_cobrar cuentas_por_cobrar_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cuentas_por_cobrar
    ADD CONSTRAINT cuentas_por_cobrar_pkey PRIMARY KEY (id);


--
-- Name: cuentas_por_pagar cuentas_por_pagar_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cuentas_por_pagar
    ADD CONSTRAINT cuentas_por_pagar_pkey PRIMARY KEY (id);


--
-- Name: metodos_pago metodos_pago_nombre_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metodos_pago
    ADD CONSTRAINT metodos_pago_nombre_key UNIQUE (nombre);


--
-- Name: metodos_pago metodos_pago_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metodos_pago
    ADD CONSTRAINT metodos_pago_pkey PRIMARY KEY (id);


--
-- Name: monedas monedas_codigo_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monedas
    ADD CONSTRAINT monedas_codigo_key UNIQUE (codigo);


--
-- Name: monedas monedas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monedas
    ADD CONSTRAINT monedas_pkey PRIMARY KEY (id);


--
-- Name: movimientos_caja movimientos_caja_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movimientos_caja
    ADD CONSTRAINT movimientos_caja_pkey PRIMARY KEY (id);


--
-- Name: movimientos_cuenta_corriente movimientos_cuenta_corriente_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movimientos_cuenta_corriente
    ADD CONSTRAINT movimientos_cuenta_corriente_pkey PRIMARY KEY (id);


--
-- Name: referencias referencias_codigo_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referencias
    ADD CONSTRAINT referencias_codigo_key UNIQUE (codigo);


--
-- Name: referencias referencias_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referencias
    ADD CONSTRAINT referencias_pkey PRIMARY KEY (id);


--
-- Name: saldos_caja saldos_caja_caja_id_moneda_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saldos_caja
    ADD CONSTRAINT saldos_caja_caja_id_moneda_id_key UNIQUE (caja_id, moneda_id);


--
-- Name: saldos_caja saldos_caja_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saldos_caja
    ADD CONSTRAINT saldos_caja_pkey PRIMARY KEY (id);


--
-- Name: tasas_cambio tasas_cambio_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasas_cambio
    ADD CONSTRAINT tasas_cambio_pkey PRIMARY KEY (id);


--
-- Name: terceros terceros_identificacion_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.terceros
    ADD CONSTRAINT terceros_identificacion_key UNIQUE (identificacion);


--
-- Name: terceros terceros_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.terceros
    ADD CONSTRAINT terceros_pkey PRIMARY KEY (id);


--
-- Name: transacciones transacciones_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transacciones
    ADD CONSTRAINT transacciones_pkey PRIMARY KEY (id);


--
-- Name: transacciones transacciones_referencia_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transacciones
    ADD CONSTRAINT transacciones_referencia_id_key UNIQUE (referencia_id);


--
-- Name: trm_colombia_historico trm_colombia_historico_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trm_colombia_historico
    ADD CONSTRAINT trm_colombia_historico_pkey PRIMARY KEY (fecha);


--
-- Name: usuarios usuarios_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usuarios
    ADD CONSTRAINT usuarios_email_key UNIQUE (email);


--
-- Name: usuarios usuarios_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usuarios
    ADD CONSTRAINT usuarios_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_configuracion whatsapp_configuracion_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_configuracion
    ADD CONSTRAINT whatsapp_configuracion_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_mensajes whatsapp_mensajes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_mensajes
    ADD CONSTRAINT whatsapp_mensajes_pkey PRIMARY KEY (id);


--
-- Name: idx_cotiz_detalle_vigente; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cotiz_detalle_vigente ON public.cotizaciones_detalle USING btree (moneda_id, tipo, etiqueta, vigente_desde DESC);


--
-- Name: idx_mov_cc_cuenta_fecha; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mov_cc_cuenta_fecha ON public.movimientos_cuenta_corriente USING btree (cuenta_corriente_id, fecha);


--
-- Name: idx_movimientos_caja_fecha; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_movimientos_caja_fecha ON public.movimientos_caja USING btree (caja_id, created_at);


--
-- Name: idx_tasas_par_fecha; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasas_par_fecha ON public.tasas_cambio USING btree (moneda_origen_id, moneda_destino_id, vigente_desde DESC);


--
-- Name: idx_transacciones_estado; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transacciones_estado ON public.transacciones USING btree (estado);


--
-- Name: idx_transacciones_fecha; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transacciones_fecha ON public.transacciones USING btree (created_at);


--
-- Name: idx_un_cierre_abierto; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_un_cierre_abierto ON public.cierres_caja USING btree (caja_id, moneda_id) WHERE (estado = 'ABIERTA'::public.estado_cierre);


--
-- Name: idx_whatsapp_mensajes_estado; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_whatsapp_mensajes_estado ON public.whatsapp_mensajes USING btree (estado, created_at DESC);


--
-- Name: saldos_caja trg_saldos_caja_actualizado; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_saldos_caja_actualizado BEFORE UPDATE ON public.saldos_caja FOR EACH ROW EXECUTE FUNCTION public.set_actualizado_en();


--
-- Name: abonos_cuenta abonos_cuenta_cuenta_por_cobrar_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.abonos_cuenta
    ADD CONSTRAINT abonos_cuenta_cuenta_por_cobrar_id_fkey FOREIGN KEY (cuenta_por_cobrar_id) REFERENCES public.cuentas_por_cobrar(id);


--
-- Name: abonos_cuenta abonos_cuenta_cuenta_por_pagar_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.abonos_cuenta
    ADD CONSTRAINT abonos_cuenta_cuenta_por_pagar_id_fkey FOREIGN KEY (cuenta_por_pagar_id) REFERENCES public.cuentas_por_pagar(id);


--
-- Name: cierres_caja cierres_caja_caja_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cierres_caja
    ADD CONSTRAINT cierres_caja_caja_id_fkey FOREIGN KEY (caja_id) REFERENCES public.cajas(id);


--
-- Name: cierres_caja cierres_caja_moneda_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cierres_caja
    ADD CONSTRAINT cierres_caja_moneda_id_fkey FOREIGN KEY (moneda_id) REFERENCES public.monedas(id);


--
-- Name: cierres_caja cierres_caja_usuario_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cierres_caja
    ADD CONSTRAINT cierres_caja_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES public.usuarios(id);


--
-- Name: cotizaciones_detalle cotizaciones_detalle_creado_por_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cotizaciones_detalle
    ADD CONSTRAINT cotizaciones_detalle_creado_por_id_fkey FOREIGN KEY (creado_por_id) REFERENCES public.usuarios(id);


--
-- Name: cotizaciones_detalle cotizaciones_detalle_moneda_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cotizaciones_detalle
    ADD CONSTRAINT cotizaciones_detalle_moneda_id_fkey FOREIGN KEY (moneda_id) REFERENCES public.monedas(id);


--
-- Name: cuentas_corrientes cuentas_corrientes_canal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cuentas_corrientes
    ADD CONSTRAINT cuentas_corrientes_canal_id_fkey FOREIGN KEY (canal_id) REFERENCES public.canales_cuenta_corriente(id);


--
-- Name: cuentas_corrientes cuentas_corrientes_moneda_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cuentas_corrientes
    ADD CONSTRAINT cuentas_corrientes_moneda_id_fkey FOREIGN KEY (moneda_id) REFERENCES public.monedas(id);


--
-- Name: cuentas_corrientes cuentas_corrientes_tercero_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cuentas_corrientes
    ADD CONSTRAINT cuentas_corrientes_tercero_id_fkey FOREIGN KEY (tercero_id) REFERENCES public.terceros(id);


--
-- Name: cuentas_por_cobrar cuentas_por_cobrar_moneda_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cuentas_por_cobrar
    ADD CONSTRAINT cuentas_por_cobrar_moneda_id_fkey FOREIGN KEY (moneda_id) REFERENCES public.monedas(id);


--
-- Name: cuentas_por_cobrar cuentas_por_cobrar_tercero_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cuentas_por_cobrar
    ADD CONSTRAINT cuentas_por_cobrar_tercero_id_fkey FOREIGN KEY (tercero_id) REFERENCES public.terceros(id);


--
-- Name: cuentas_por_pagar cuentas_por_pagar_moneda_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cuentas_por_pagar
    ADD CONSTRAINT cuentas_por_pagar_moneda_id_fkey FOREIGN KEY (moneda_id) REFERENCES public.monedas(id);


--
-- Name: cuentas_por_pagar cuentas_por_pagar_tercero_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cuentas_por_pagar
    ADD CONSTRAINT cuentas_por_pagar_tercero_id_fkey FOREIGN KEY (tercero_id) REFERENCES public.terceros(id);


--
-- Name: movimientos_caja movimientos_caja_caja_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movimientos_caja
    ADD CONSTRAINT movimientos_caja_caja_id_fkey FOREIGN KEY (caja_id) REFERENCES public.cajas(id);


--
-- Name: movimientos_caja movimientos_caja_categoria_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movimientos_caja
    ADD CONSTRAINT movimientos_caja_categoria_id_fkey FOREIGN KEY (categoria_id) REFERENCES public.categorias_movimiento(id);


--
-- Name: movimientos_caja movimientos_caja_metodo_pago_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movimientos_caja
    ADD CONSTRAINT movimientos_caja_metodo_pago_id_fkey FOREIGN KEY (metodo_pago_id) REFERENCES public.metodos_pago(id);


--
-- Name: movimientos_caja movimientos_caja_moneda_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movimientos_caja
    ADD CONSTRAINT movimientos_caja_moneda_id_fkey FOREIGN KEY (moneda_id) REFERENCES public.monedas(id);


--
-- Name: movimientos_caja movimientos_caja_transaccion_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movimientos_caja
    ADD CONSTRAINT movimientos_caja_transaccion_id_fkey FOREIGN KEY (transaccion_id) REFERENCES public.transacciones(id);


--
-- Name: movimientos_caja movimientos_caja_usuario_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movimientos_caja
    ADD CONSTRAINT movimientos_caja_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES public.usuarios(id);


--
-- Name: movimientos_cuenta_corriente movimientos_cuenta_corriente_categoria_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movimientos_cuenta_corriente
    ADD CONSTRAINT movimientos_cuenta_corriente_categoria_id_fkey FOREIGN KEY (categoria_id) REFERENCES public.categorias_movimiento(id);


--
-- Name: movimientos_cuenta_corriente movimientos_cuenta_corriente_cuenta_corriente_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movimientos_cuenta_corriente
    ADD CONSTRAINT movimientos_cuenta_corriente_cuenta_corriente_id_fkey FOREIGN KEY (cuenta_corriente_id) REFERENCES public.cuentas_corrientes(id);


--
-- Name: movimientos_cuenta_corriente movimientos_cuenta_corriente_moneda_base_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movimientos_cuenta_corriente
    ADD CONSTRAINT movimientos_cuenta_corriente_moneda_base_id_fkey FOREIGN KEY (moneda_base_id) REFERENCES public.monedas(id);


--
-- Name: movimientos_cuenta_corriente movimientos_cuenta_corriente_transaccion_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movimientos_cuenta_corriente
    ADD CONSTRAINT movimientos_cuenta_corriente_transaccion_id_fkey FOREIGN KEY (transaccion_id) REFERENCES public.transacciones(id);


--
-- Name: movimientos_cuenta_corriente movimientos_cuenta_corriente_usuario_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movimientos_cuenta_corriente
    ADD CONSTRAINT movimientos_cuenta_corriente_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES public.usuarios(id);


--
-- Name: saldos_caja saldos_caja_caja_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saldos_caja
    ADD CONSTRAINT saldos_caja_caja_id_fkey FOREIGN KEY (caja_id) REFERENCES public.cajas(id);


--
-- Name: saldos_caja saldos_caja_moneda_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saldos_caja
    ADD CONSTRAINT saldos_caja_moneda_id_fkey FOREIGN KEY (moneda_id) REFERENCES public.monedas(id);


--
-- Name: tasas_cambio tasas_cambio_creado_por_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasas_cambio
    ADD CONSTRAINT tasas_cambio_creado_por_id_fkey FOREIGN KEY (creado_por_id) REFERENCES public.usuarios(id);


--
-- Name: tasas_cambio tasas_cambio_moneda_destino_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasas_cambio
    ADD CONSTRAINT tasas_cambio_moneda_destino_id_fkey FOREIGN KEY (moneda_destino_id) REFERENCES public.monedas(id);


--
-- Name: tasas_cambio tasas_cambio_moneda_origen_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasas_cambio
    ADD CONSTRAINT tasas_cambio_moneda_origen_id_fkey FOREIGN KEY (moneda_origen_id) REFERENCES public.monedas(id);


--
-- Name: transacciones transacciones_caja_destino_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transacciones
    ADD CONSTRAINT transacciones_caja_destino_id_fkey FOREIGN KEY (caja_destino_id) REFERENCES public.cajas(id);


--
-- Name: transacciones transacciones_caja_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transacciones
    ADD CONSTRAINT transacciones_caja_id_fkey FOREIGN KEY (caja_id) REFERENCES public.cajas(id);


--
-- Name: transacciones transacciones_confirmado_por_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transacciones
    ADD CONSTRAINT transacciones_confirmado_por_id_fkey FOREIGN KEY (confirmado_por_id) REFERENCES public.usuarios(id);


--
-- Name: transacciones transacciones_cotizacion_detalle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transacciones
    ADD CONSTRAINT transacciones_cotizacion_detalle_id_fkey FOREIGN KEY (cotizacion_detalle_id) REFERENCES public.cotizaciones_detalle(id);


--
-- Name: transacciones transacciones_metodo_pago_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transacciones
    ADD CONSTRAINT transacciones_metodo_pago_id_fkey FOREIGN KEY (metodo_pago_id) REFERENCES public.metodos_pago(id);


--
-- Name: transacciones transacciones_moneda_destino_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transacciones
    ADD CONSTRAINT transacciones_moneda_destino_id_fkey FOREIGN KEY (moneda_destino_id) REFERENCES public.monedas(id);


--
-- Name: transacciones transacciones_moneda_origen_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transacciones
    ADD CONSTRAINT transacciones_moneda_origen_id_fkey FOREIGN KEY (moneda_origen_id) REFERENCES public.monedas(id);


--
-- Name: transacciones transacciones_referencia_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transacciones
    ADD CONSTRAINT transacciones_referencia_id_fkey FOREIGN KEY (referencia_id) REFERENCES public.referencias(id);


--
-- Name: transacciones transacciones_tasa_cambio_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transacciones
    ADD CONSTRAINT transacciones_tasa_cambio_id_fkey FOREIGN KEY (tasa_cambio_id) REFERENCES public.tasas_cambio(id);


--
-- Name: transacciones transacciones_tercero_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transacciones
    ADD CONSTRAINT transacciones_tercero_id_fkey FOREIGN KEY (tercero_id) REFERENCES public.terceros(id);


--
-- Name: transacciones transacciones_usuario_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transacciones
    ADD CONSTRAINT transacciones_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES public.usuarios(id);


--
-- Name: whatsapp_mensajes whatsapp_mensajes_moneda_detectada_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_mensajes
    ADD CONSTRAINT whatsapp_mensajes_moneda_detectada_id_fkey FOREIGN KEY (moneda_detectada_id) REFERENCES public.monedas(id);


--
-- Name: whatsapp_mensajes whatsapp_mensajes_tercero_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_mensajes
    ADD CONSTRAINT whatsapp_mensajes_tercero_id_fkey FOREIGN KEY (tercero_id) REFERENCES public.terceros(id);


--
-- PostgreSQL database dump complete
--


--
-- Cuentas y documentos del tercero (migración 002)
--

SET search_path = public;

-- Cuentas a donde se le paga al cliente (banco, pago móvil, Zelle, Nequi...)
CREATE TABLE IF NOT EXISTS cuentas_tercero (
  id SERIAL PRIMARY KEY,
  tercero_id integer NOT NULL REFERENCES terceros(id),
  moneda_id integer REFERENCES monedas(id),
  tipo text NOT NULL CHECK (tipo IN ('CUENTA_BANCARIA', 'PAGO_MOVIL', 'ZELLE', 'NEQUI', 'DAVIPLATA', 'OTRO')),
  banco text,
  numero_cuenta text,
  tipo_cuenta text CHECK (tipo_cuenta IN ('AHORRO', 'CORRIENTE')),
  titular text NOT NULL,
  identificacion_titular text,
  telefono text,
  email text,
  alias text,
  activo boolean NOT NULL DEFAULT true,
  creado_por_id integer NOT NULL REFERENCES usuarios(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cuentas_tercero_tercero ON cuentas_tercero (tercero_id);

-- Documentos del cliente (cédula, RIF, soportes). El archivo vive en Cloudinary (privado);
-- aquí solo la ruta (archivo_key). Nunca se borran: se aprueban o rechazan.
CREATE TABLE IF NOT EXISTS documentos_tercero (
  id SERIAL PRIMARY KEY,
  tercero_id integer NOT NULL REFERENCES terceros(id),
  transaccion_id integer REFERENCES transacciones(id),
  tipo text NOT NULL CHECK (tipo IN ('CEDULA', 'RIF', 'PASAPORTE', 'COMPROBANTE_DOMICILIO', 'ORIGEN_FONDOS', 'OTRO')),
  descripcion text,
  archivo_key text NOT NULL UNIQUE,
  nombre_original text NOT NULL,
  mime_type text NOT NULL,
  tamano_bytes integer NOT NULL,
  fecha_vencimiento date,
  estado text NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN ('PENDIENTE', 'APROBADO', 'RECHAZADO')),
  motivo_rechazo text,
  revisado_por_id integer REFERENCES usuarios(id),
  revisado_en timestamptz,
  subido_por_id integer NOT NULL REFERENCES usuarios(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_documentos_tercero_tercero ON documentos_tercero (tercero_id);

-- A qué cuenta del cliente se le pagó en un cambio
ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS cuenta_tercero_id integer REFERENCES cuentas_tercero(id);
