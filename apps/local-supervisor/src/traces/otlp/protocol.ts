import { Root } from 'protobufjs';

export const OTLP_PROTO_VERSION = 'v1.9.0';
export const OTLP_PROTO_SOURCE = 'https://github.com/open-telemetry/opentelemetry-proto/tree/v1.9.0/opentelemetry/proto';

const root = Root.fromJSON({ nested: {
	AnyValue: {
		oneofs: { value: { oneof: ['stringValue', 'boolValue', 'intValue', 'doubleValue', 'arrayValue', 'kvlistValue', 'bytesValue'] } },
		fields: {
			stringValue: { type: 'string', id: 1 }, boolValue: { type: 'bool', id: 2 },
			intValue: { type: 'int64', id: 3 }, doubleValue: { type: 'double', id: 4 },
			arrayValue: { type: 'ArrayValue', id: 5 }, kvlistValue: { type: 'KeyValueList', id: 6 }, bytesValue: { type: 'bytes', id: 7 },
		},
	},
	ArrayValue: { fields: { values: { rule: 'repeated', type: 'AnyValue', id: 1 } } },
	KeyValueList: { fields: { values: { rule: 'repeated', type: 'KeyValue', id: 1 } } },
	KeyValue: { fields: { key: { type: 'string', id: 1 }, value: { type: 'AnyValue', id: 2 } } },
	InstrumentationScope: { fields: {
		name: { type: 'string', id: 1 }, version: { type: 'string', id: 2 },
		attributes: { rule: 'repeated', type: 'KeyValue', id: 3 }, droppedAttributesCount: { type: 'uint32', id: 4 },
	} },
	EntityRef: { fields: {
		schemaUrl: { type: 'string', id: 1 }, type: { type: 'string', id: 2 },
		idKeys: { rule: 'repeated', type: 'string', id: 3 }, descriptionKeys: { rule: 'repeated', type: 'string', id: 4 },
	} },
	Resource: { fields: {
		attributes: { rule: 'repeated', type: 'KeyValue', id: 1 }, droppedAttributesCount: { type: 'uint32', id: 2 },
		entityRefs: { rule: 'repeated', type: 'EntityRef', id: 3 },
	} },
	ResourceSpans: { fields: {
		resource: { type: 'Resource', id: 1 }, scopeSpans: { rule: 'repeated', type: 'ScopeSpans', id: 2 }, schemaUrl: { type: 'string', id: 3 },
	} },
	ScopeSpans: { fields: {
		scope: { type: 'InstrumentationScope', id: 1 }, spans: { rule: 'repeated', type: 'Span', id: 2 }, schemaUrl: { type: 'string', id: 3 },
	} },
	Span: {
		fields: {
			traceId: { type: 'bytes', id: 1 }, spanId: { type: 'bytes', id: 2 }, traceState: { type: 'string', id: 3 },
			parentSpanId: { type: 'bytes', id: 4 }, name: { type: 'string', id: 5 }, kind: { type: 'SpanKind', id: 6 },
			startTimeUnixNano: { type: 'fixed64', id: 7 }, endTimeUnixNano: { type: 'fixed64', id: 8 },
			attributes: { rule: 'repeated', type: 'KeyValue', id: 9 }, droppedAttributesCount: { type: 'uint32', id: 10 },
			events: { rule: 'repeated', type: 'Event', id: 11 }, droppedEventsCount: { type: 'uint32', id: 12 },
			links: { rule: 'repeated', type: 'Link', id: 13 }, droppedLinksCount: { type: 'uint32', id: 14 },
			status: { type: 'Status', id: 15 }, flags: { type: 'fixed32', id: 16 },
		},
		nested: {
			SpanKind: { values: { SPAN_KIND_UNSPECIFIED: 0, SPAN_KIND_INTERNAL: 1, SPAN_KIND_SERVER: 2, SPAN_KIND_CLIENT: 3, SPAN_KIND_PRODUCER: 4, SPAN_KIND_CONSUMER: 5 } },
			Event: { fields: {
				timeUnixNano: { type: 'fixed64', id: 1 }, name: { type: 'string', id: 2 },
				attributes: { rule: 'repeated', type: 'KeyValue', id: 3 }, droppedAttributesCount: { type: 'uint32', id: 4 },
			} },
			Link: { fields: {
				traceId: { type: 'bytes', id: 1 }, spanId: { type: 'bytes', id: 2 }, traceState: { type: 'string', id: 3 },
				attributes: { rule: 'repeated', type: 'KeyValue', id: 4 }, droppedAttributesCount: { type: 'uint32', id: 5 }, flags: { type: 'fixed32', id: 6 },
			} },
		},
	},
	Status: {
		fields: { message: { type: 'string', id: 2 }, code: { type: 'StatusCode', id: 3 } },
		nested: { StatusCode: { values: { STATUS_CODE_UNSET: 0, STATUS_CODE_OK: 1, STATUS_CODE_ERROR: 2 } } },
	},
	ExportTraceServiceRequest: { fields: { resourceSpans: { rule: 'repeated', type: 'ResourceSpans', id: 1 } } },
	ExportTraceServiceResponse: { fields: { partialSuccess: { type: 'ExportTracePartialSuccess', id: 1 } } },
	ExportTracePartialSuccess: { fields: { rejectedSpans: { type: 'int64', id: 1 }, errorMessage: { type: 'string', id: 2 } } },
} }).resolveAll();

export const exportTraceRequest = root.lookupType('ExportTraceServiceRequest');
export const exportTraceResponse = root.lookupType('ExportTraceServiceResponse');
export type OtlpEncoding = 'json' | 'protobuf';

export interface AnyValue {
	stringValue?: string; boolValue?: boolean; intValue?: string; doubleValue?: number | string;
	arrayValue?: { values?: AnyValue[] }; kvlistValue?: { values?: KeyValue[] }; bytesValue?: string;
}
export interface KeyValue { key?: string; value?: AnyValue }
export interface AttributeMessage { attributes?: KeyValue[]; droppedAttributesCount?: number }
export interface OtlpEvent extends AttributeMessage { timeUnixNano?: string; name?: string }
export interface OtlpLink extends AttributeMessage { traceId?: string; spanId?: string; traceState?: string; flags?: number }
export interface OtlpSpan extends OtlpLink {
	parentSpanId?: string; name?: string; kind?: number; startTimeUnixNano?: string; endTimeUnixNano?: string;
	events?: OtlpEvent[]; droppedEventsCount?: number; links?: OtlpLink[]; droppedLinksCount?: number;
	status?: { message?: string; code?: number };
}
export interface ScopeSpans {
	scope?: AttributeMessage & { name?: string; version?: string }; spans?: OtlpSpan[]; schemaUrl?: string;
}
export interface ResourceSpans {
	resource?: AttributeMessage & { entityRefs?: { schemaUrl?: string; type?: string; idKeys?: string[]; descriptionKeys?: string[] }[] };
	scopeSpans?: ScopeSpans[]; schemaUrl?: string;
}
export interface OtlpRequest { resourceSpans?: ResourceSpans[] }