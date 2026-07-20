/** Raw Vast.ai API response shapes (only the fields we consume). */

export interface RawOffer {
  id: number
  machine_id: number
  gpu_name: string
  num_gpus: number
  /** MB per GPU */
  gpu_ram: number
  dph_total: number
  dlperf_per_dphtotal?: number
  inet_down: number
  inet_up: number
  reliability2?: number
  reliability?: number
  cuda_max_good?: number
  geolocation?: string
  disk_space: number
  rentable?: boolean
}

export interface RawInstance {
  id: number
  machine_id: number
  actual_status?: string // 'running' | 'loading' | 'offline' | ...
  intended_status?: string
  cur_state?: string
  ssh_host?: string
  ssh_port?: number
  public_ipaddr?: string
  ports?: Record<string, Array<{ HostIp: string; HostPort: string }>>
  gpu_name?: string
  num_gpus?: number
  dph_total?: number
  /** epoch seconds */
  start_date?: number
  label?: string
  status_msg?: string
}

export interface VastUser {
  id: number
  email?: string
  credit?: number
  balance?: number
  user?: string
}
