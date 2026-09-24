export function total(net) { return net * (1 + 0.0825); }
export function tax(net) { return net * 0.0825; }
export function netOf(gross) { return gross / (1 + 0.0825); }
