#!/usr/bin/env node

const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

// Jenkins-themed colors
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m'
};

// Jenkins-style status indicators
const statusIcons = {
  Running: '🟢',
  Pending: '🟡',
  Failed: '🔴',
  Succeeded: '✅',
  Unknown: '❓',
  ContainerCreating: '🔄',
  CrashLoopBackOff: '💥',
  ImagePullBackOff: '📥'
};

class JenkinsPodMonitor {
  constructor() {
    this.namespace = process.env.JENKINS_NAMESPACE || 'cloudbees-core';
    this.labelSelector = process.env.JENKINS_LABEL || 'app.kubernetes.io/name=cloudbees-core';
  }

  async checkKubectl() {
    try {
      await execAsync('kubectl version --client');
      return true;
    } catch (error) {
      console.error(`${colors.red}❌ kubectl is not installed or not in PATH${colors.reset}`);
      return false;
    }
  }

  async getJenkinsPods() {
    try {
      const cmd = `kubectl get pods -n ${this.namespace} -l ${this.labelSelector} -o json`;
      const { stdout } = await execAsync(cmd);
      const data = JSON.parse(stdout);
      return data.items || [];
    } catch (error) {
      if (error.message.includes('No resources found')) {
        return [];
      }
      throw error;
    }
  }

  async getStatefulSets() {
    try {
      const cmd = `kubectl get statefulsets -n ${this.namespace} -l ${this.labelSelector} -o json`;
      const { stdout } = await execAsync(cmd);
      const data = JSON.parse(stdout);
      return data.items || [];
    } catch (error) {
      if (error.message.includes('No resources found')) {
        return [];
      }
      throw error;
    }
  }

  formatUptime(startTime) {
    const start = new Date(startTime);
    const now = new Date();
    const diffMs = now - start;
    
    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
    
    if (days > 0) return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  getStatusColor(status) {
    switch (status) {
      case 'Running': return colors.green;
      case 'Pending': case 'ContainerCreating': return colors.yellow;
      case 'Failed': case 'CrashLoopBackOff': case 'ImagePullBackOff': return colors.red;
      case 'Succeeded': return colors.cyan;
      default: return colors.dim;
    }
  }

  formatRestartInfo(restartCount, lastRestartTime) {
    if (restartCount === 0) {
      return `${colors.green}No restarts${colors.reset}`;
    }
    
    const restartColor = restartCount > 5 ? colors.red : restartCount > 2 ? colors.yellow : colors.cyan;
    const timeAgo = lastRestartTime ? this.formatUptime(lastRestartTime) : 'unknown';
    return `${restartColor}${restartCount} restarts${colors.reset} ${colors.dim}(last: ${timeAgo} ago)${colors.reset}`;
  }

  formatHealthStatus(conditions) {
    if (!conditions || conditions.length === 0) {
      return `${colors.dim}No health data${colors.reset}`;
    }

    const ready = conditions.find(c => c.type === 'Ready');
    const scheduled = conditions.find(c => c.type === 'PodScheduled');
    const initialized = conditions.find(c => c.type === 'Initialized');

    let health = [];
    if (ready) {
      const icon = ready.status === 'True' ? '✅' : '❌';
      const color = ready.status === 'True' ? colors.green : colors.red;
      health.push(`${color}Ready: ${icon}${colors.reset}`);
    }
    if (scheduled && scheduled.status === 'True') {
      health.push(`${colors.green}Scheduled: ✅${colors.reset}`);
    }
    if (initialized && initialized.status === 'True') {
      health.push(`${colors.green}Initialized: ✅${colors.reset}`);
    }

    return health.join(' | ') || `${colors.dim}Unknown${colors.reset}`;
  }

  printHeader() {
    console.log(`
${colors.blue}╔══════════════════════════════════════════════════════════════════════════════╗
║                        🏗️  CLOUDBEES CORE POD MONITOR 🏗️                      ║
╚══════════════════════════════════════════════════════════════════════════════╝${colors.reset}
`);
    console.log(`${colors.dim}Namespace: ${colors.cyan}${this.namespace}${colors.dim} | Label Selector: ${colors.cyan}${this.labelSelector}${colors.reset}`);
    console.log(`${colors.dim}Timestamp: ${colors.white}${new Date().toLocaleString()}${colors.reset}\n`);
  }

  printPodInfo(pod, statefulSetInfo = null) {
    const name = pod.metadata.name;
    const status = pod.status.phase;
    const node = pod.spec.nodeName || 'Unscheduled';
    const startTime = pod.status.startTime;
    const uptime = startTime ? this.formatUptime(startTime) : 'N/A';
    
    // Check if this is a StatefulSet pod
    const isStatefulSet = pod.metadata.ownerReferences?.some(ref => ref.kind === 'StatefulSet');
    const statefulSetName = isStatefulSet ? pod.metadata.ownerReferences.find(ref => ref.kind === 'StatefulSet')?.name : null;
    
    // Container info
    const containers = pod.status.containerStatuses || [];
    const mainContainer = containers.find(c => c.name.includes('jenkins') || c.name.includes('cloudbees')) || containers[0];
    
    const restartCount = mainContainer ? mainContainer.restartCount : 0;
    const lastRestartTime = mainContainer?.lastState?.terminated?.finishedAt;
    
    const statusIcon = statusIcons[status] || statusIcons.Unknown;
    const statusColor = this.getStatusColor(status);
    
    // StatefulSet specific info
    const podTypeIcon = isStatefulSet ? '📊' : '📦';
    const podType = isStatefulSet ? 'StatefulSet Pod' : 'Pod';
    
    console.log(`${colors.bright}${podTypeIcon} ${podType}: ${colors.cyan}${name}${colors.reset}`);
    if (statefulSetName) {
      console.log(`   🏗️  StatefulSet: ${colors.magenta}${statefulSetName}${colors.reset}`);
    }
    console.log(`   ${statusIcon} Status: ${statusColor}${status}${colors.reset}`);
    console.log(`   🖥️  Node: ${colors.white}${node}${colors.reset}`);
    console.log(`   ⏱️  Uptime: ${colors.green}${uptime}${colors.reset}`);
    console.log(`   🔄 Restarts: ${this.formatRestartInfo(restartCount, lastRestartTime)}`);
    console.log(`   🏥 Health: ${this.formatHealthStatus(pod.status.conditions)}`);
    
    // Storage info for StatefulSet pods
    if (isStatefulSet && pod.spec.volumes) {
      const pvcs = pod.spec.volumes.filter(v => v.persistentVolumeClaim);
      if (pvcs.length > 0) {
        console.log(`   💾 Persistent Volumes:`);
        pvcs.forEach(pvc => {
          console.log(`      • ${colors.yellow}${pvc.persistentVolumeClaim.claimName}${colors.reset}`);
        });
      }
    }
    
    // Container details
    if (containers.length > 0) {
      console.log(`   📋 Containers:`);
      containers.forEach(container => {
        const containerStatus = container.ready ? '🟢 Ready' : '🔴 Not Ready';
        const image = container.image.split('/').pop(); // Get just the image name
        console.log(`      • ${colors.cyan}${container.name}${colors.reset}: ${containerStatus} (${colors.dim}${image}${colors.reset})`);
      });
    }
    
    console.log(`${colors.dim}   ────────────────────────────────────────────────────────────────────────${colors.reset}\n`);
  }

  printSummary(pods, statefulSets) {
    const totalPods = pods.length;
    const runningPods = pods.filter(p => p.status.phase === 'Running').length;
    const pendingPods = pods.filter(p => p.status.phase === 'Pending').length;
    const failedPods = pods.filter(p => p.status.phase === 'Failed').length;
    const statefulSetPods = pods.filter(p => p.metadata.ownerReferences?.some(ref => ref.kind === 'StatefulSet')).length;
    
    console.log(`${colors.blue}╔═══════════════════════════════════════════════════════════════════════════════╗`);
    console.log(`║                                   SUMMARY                                     ║`);
    console.log(`╠═══════════════════════════════════════════════════════════════════════════════╣`);
    console.log(`║ Total Pods: ${colors.white}${totalPods.toString().padStart(3)}${colors.blue}  │  Running: ${colors.green}${runningPods.toString().padStart(3)}${colors.blue}  │  Pending: ${colors.yellow}${pendingPods.toString().padStart(3)}${colors.blue}  │  Failed: ${colors.red}${failedPods.toString().padStart(3)}${colors.blue} ║`);
    console.log(`║ StatefulSets: ${colors.magenta}${statefulSets.length.toString().padStart(2)}${colors.blue}   │  StatefulSet Pods: ${colors.cyan}${statefulSetPods.toString().padStart(3)}${colors.blue}                              ║`);
    console.log(`╚═══════════════════════════════════════════════════════════════════════════════╝${colors.reset}`);
    
    // StatefulSet status
    if (statefulSets.length > 0) {
      console.log(`\n${colors.bright}📊 StatefulSet Status:${colors.reset}`);
      statefulSets.forEach(sts => {
        const desired = sts.spec.replicas || 0;
        const ready = sts.status.readyReplicas || 0;
        const current = sts.status.currentReplicas || 0;
        const statusColor = ready === desired ? colors.green : ready === 0 ? colors.red : colors.yellow;
        console.log(`   • ${colors.cyan}${sts.metadata.name}${colors.reset}: ${statusColor}${ready}/${desired} ready${colors.reset} (${current} current)`);
      });
    }
    
    // Health indicator
    const healthStatus = runningPods === totalPods && totalPods > 0 ? 'HEALTHY' : 
                        failedPods > 0 ? 'UNHEALTHY' : 'DEGRADED';
    const healthColor = healthStatus === 'HEALTHY' ? colors.green : 
                       healthStatus === 'UNHEALTHY' ? colors.red : colors.yellow;
    
    console.log(`\n${colors.bright}Overall CloudBees Core Status: ${healthColor}${healthStatus}${colors.reset} ${statusIcons[healthStatus === 'HEALTHY' ? 'Running' : healthStatus === 'UNHEALTHY' ? 'Failed' : 'Pending']}\n`);
  }

  async run() {
    try {
      this.printHeader();
      
      // Check if kubectl is available
      if (!(await this.checkKubectl())) {
        process.exit(1);
      }
      
      // Get Jenkins pods and StatefulSets
      console.log(`${colors.dim}🔍 Searching for CloudBees Core pods and StatefulSets...${colors.reset}\n`);
      const [pods, statefulSets] = await Promise.all([
        this.getJenkinsPods(),
        this.getStatefulSets()
      ]);
      
      if (pods.length === 0 && statefulSets.length === 0) {
        console.log(`${colors.yellow}⚠️  No CloudBees Core resources found in namespace '${this.namespace}' with label '${this.labelSelector}'${colors.reset}`);
        console.log(`${colors.dim}Try adjusting the JENKINS_NAMESPACE or JENKINS_LABEL environment variables${colors.reset}`);
        console.log(`${colors.dim}Common CloudBees Core labels: app.kubernetes.io/name=cloudbees-core, app=cjoc, app=jenkins${colors.reset}`);
        return;
      }
      
      // Display pod information
      pods.forEach(pod => this.printPodInfo(pod));
      
      // Display summary
      this.printSummary(pods, statefulSets);
      
    } catch (error) {
      console.error(`${colors.red}❌ Error: ${error.message}${colors.reset}`);
      process.exit(1);
    }
  }
}

// Handle command line arguments
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
${colors.blue}Jenkins Pod Status Monitor${colors.reset}

Usage: node jenkins-pod-monitor.js [options]

Environment Variables:
  JENKINS_NAMESPACE    Kubernetes namespace to search (default: cloudbees-core)
  JENKINS_LABEL        Label selector for pods (default: app.kubernetes.io/name=cloudbees-core)

Options:
  --help, -h          Show this help message
  --watch, -w         Watch mode (refresh every 30 seconds)

Examples:
  node jenkins-pod-monitor.js
  JENKINS_NAMESPACE=jenkins-system node jenkins-pod-monitor.js
  JENKINS_LABEL="app=cjoc" node jenkins-pod-monitor.js --watch
  JENKINS_LABEL="app=jenkins" node jenkins-pod-monitor.js
`);
  process.exit(0);
}

// Watch mode
if (process.argv.includes('--watch') || process.argv.includes('-w')) {
  const monitor = new JenkinsPodMonitor();
  
  const runMonitor = async () => {
    console.clear();
    await monitor.run();
    console.log(`${colors.dim}🔄 Refreshing in 30 seconds... (Press Ctrl+C to exit)${colors.reset}`);
  };
  
  runMonitor();
  setInterval(runMonitor, 30000);
} else {
  // Single run
  const monitor = new JenkinsPodMonitor();
  monitor.run();
}
