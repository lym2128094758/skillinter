// Reconstruct only from DSH's durable session events, not from model claims.
export function skillTrace(events, turn) {
  const calls = new Map(), result = [];
  for (const event of events) {
    const data=event.data;
    if (!data || (turn != null && data.turn !== turn)) continue;
    if (event.type === 'tool/call') {
      let args;
      try { args = typeof data.arguments === 'string' ? JSON.parse(data.arguments) : data.arguments; } catch { args = {}; }
      calls.set(String(data.callId),{name:data.name,skill:data.name==='skill' && typeof args?.name==='string' ? args.name : undefined,turn:data.turn,step:data.step});
    } else if (event.type === 'tool/result') {
      const message=data.message;
      const block=message?.content?.find(item => item.type === 'tool-result');
      const call=calls.get(String(block?.toolCallId ?? message?.source?.callId));
      if (call) result.push({...call,success:!block?.isError && !data.error});
    }
  }
  return result;
}
