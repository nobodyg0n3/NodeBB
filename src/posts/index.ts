'use strict';

import * as _ from 'lodash';

import * as db from '../database';
import * as utils from '../utils';
import * as user from '../user';
import * as privileges from '../privileges';
import * as plugins from '../plugins';

interface Post {
  pid: number;
  tid: number;
  deleted: boolean;
  selfPost: boolean;
  user: {
    signature: string;
  };
  content: string;
}

interface PostData {
  posts: Post[];
  nextStart: number;
}

const Posts: {
  exists(pids: number | number[]): Promise<boolean>;
  getPidsFromSet(set: string, start: number, stop: number, reverse: boolean): Promise<number[]>;
  getPostsByPids(pids: number[], uid: number): Promise<Post[]>;
  getPostSummariesFromSet(set: string, uid: number, start: number, stop: number): Promise<PostData>;
  getPidIndex(pid: number, tid: number, topicPostSort: string): Promise<number>;
  getPostIndices(posts: Post[], uid: number): Promise<number[]>;
  modifyPostByPrivilege(post: Post, privileges: any): void;
} = {} as any;

require('./data')(Posts);
require('./create')(Posts);
require('./delete')(Posts);
require('./edit')(Posts);
require('./parse')(Posts);
require('./user')(Posts);
require('./topics')(Posts);
require('./category')(Posts);
require('./summary')(Posts);
require('./recent')(Posts);
require('./tools')(Posts);
require('./votes')(Posts);
require('./bookmarks')(Posts);
require('./queue')(Posts);
require('./diffs')(Posts);
require('./uploads')(Posts);

Posts.exists = async function (pids: number | number[]): Promise<boolean> {
  return await db.exists(
    Array.isArray(pids) ? pids.map(pid => `post:${pid}`) : `post:${pids}`
  );
};

Posts.getPidsFromSet = async function (set: string, start: number, stop: number, reverse: boolean): Promise<number[]> {
  if (isNaN(start) || isNaN(stop)) {
    return [];
  }
  return await db[reverse ? 'getSortedSetRevRange' : 'getSortedSetRange'](set, start, stop);
};

Posts.getPostsByPids = async function (pids: number[], uid: number): Promise<Post[]> {
  if (!Array.isArray(pids) || !pids.length) {
    return [];
  }
  let posts = await Posts.getPostsData(pids);
  posts = await Promise.all(posts.map(Posts.parsePost));
  const data = await plugins.hooks.fire('filter:post.getPosts', { posts: posts, uid: uid });
  if (!data || !Array.isArray(data.posts)) {
    return [];
  }
  return data.posts.filter(Boolean);
};

Posts.getPostSummariesFromSet = async function (set: string, uid: number, start: number, stop: number): Promise<PostData> {
  let pids = await db.getSortedSetRevRange(set, start, stop);
  pids = await privileges.posts.filter('topics:read', pids, uid);
  const posts = await Posts.getPostSummaryByPids(pids, uid, { stripTags: false });
  return { posts: posts, nextStart: stop + 1 };
};

Posts.getPidIndex = async function (pid: number, tid: number, topicPostSort: string): Promise<number> {
  const set = topicPostSort === 'most_votes' ? `tid:${tid}:posts:votes` : `tid:${tid}:posts`;
  const reverse = topicPostSort === 'newest_to_oldest' || topicPostSort === 'most_votes';
  const index = await db[reverse ? 'sortedSetRevRank' : 'sortedSetRank'](set, pid);
  if (!utils.isNumber(index)) {
    return 0;
  }
  return utils.isNumber(index) ? parseInt(index, 10) + 1 : 0;
};

Posts.getPostIndices = async function (posts: Post[], uid: number): Promise<number[]> {
  if (!Array.isArray(posts) || !posts.length) {
    return [];
  }
  const settings = await user.getSettings(uid);

  const byVotes = settings.topicPostSort === 'most_votes';
  let sets = posts.map(p => (byVotes ? `tid:${p.tid}:posts:votes` : `tid:${p.tid}:posts`));
  const reverse = settings.topicPostSort === 'newest_to_oldest' || settings.topicPostSort === 'most_votes';

  const uniqueSets = _.uniq(sets);
  let method = reverse ? 'sortedSetsRevRanks' : 'sortedSetsRanks';
  if (uniqueSets.length === 1) {
    method = reverse ? 'sortedSetRevRanks' : 'sortedSetRanks';
    sets = uniqueSets[0];
  }

  const pids = posts.map(post => post.pid);
  const indices = await db[method](sets, pids);
  return indices.map(index => (utils.isNumber(index) ? parseInt(index, 10) + 1 : 0));
};

Posts.modifyPostByPrivilege = function (post: Post, privileges: any): void {
  if (post && post.deleted && !(post.selfPost || privileges['posts:view_deleted'])) {
    post.content = '[[topic:post_is_deleted]]';
    if (post.user) {
      post.user.signature = '';
    }
  }
};

require('../promisify')(Posts);