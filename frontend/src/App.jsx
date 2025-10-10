import React, { useState } from 'react';
import axios from 'axios';

//Format date in this format January 1, 2024, 10:00 AM
const formatDate = (timestamp) => {
  const date = new Date(timestamp * 1000);
  return date.toLocaleString('default',
    { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: 'numeric', hour12: true });
};

// format views, likes, comments, shares with commas
const formatNumber = (num) => {
  if (num === undefined || num === null) return '0';
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
};

// Format duration from seconds to 1 1hr 2mins 3secs
const formatDuration = (seconds) => {
  if (!seconds || isNaN(seconds) || seconds <= 0) return '0 secs';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  let result = '';
  if (hrs > 0) result += `${hrs} hr${hrs > 1 ? 's' : ''} `;
  if (mins > 0) result += `${mins} min${mins > 1 ? 's' : ''} `;
  if (secs > 0) result += `${secs} sec${secs > 1 ? 's' : ''}`;
  return result.trim();
};


//format 1000 to 1K, 1000000 to 1M
const formatCount = (num) => {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  }
  return num.toString();
};

const App = () => {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');



  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!url.trim()) return;

    setLoading(true);
    setError('');
    setResult(null);

    try {
      // Call backend API
      const response = await axios.post('http://localhost:4000/api/download', { url: url.trim() });
      // console.log('API Response:', response.data); // Log the response
      const apiData = response.data;
      console.log('API Data:', apiData); // Log the parsed data

      setResult({
        id: apiData.id || '',
        region: apiData.region || '',
        type: apiData.type || (apiData.images ? 'carousel' : 'video'),
        images: Array.isArray(apiData.images) ? apiData.images : [],
        original: apiData.original || '',
        origin_cover: apiData.origin_cover || '',
        duration: apiData.duration ?? '',
        views: apiData.play_count ?? '',
        likes: apiData.digg_count ?? '',
        play_count: apiData.play_count ?? '',
        comment_count: apiData.comment_count ?? '',
        download_count: apiData.download_count ?? '',
        share_count: apiData.share_count ?? '',
        title: apiData.title || '',
        avatar: apiData.author && apiData.author.avatar ? apiData.author.avatar : '',
        nickname: apiData.author && apiData.author.nickname ? apiData.author.nickname : '',
        uniqueId: apiData.author && apiData.author.unique_id ? apiData.author.unique_id : '',
        video: apiData.play || apiData.video || '',
        postedOn: apiData.create_time ? apiData.create_time : '',
      });
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to download TikTok content');
    } finally {
      setLoading(false);
    }
  };


  const downloadFile = async (fileUrl, filename) => {
    try {
      const response = await fetch(fileUrl);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err) {
      alert('Download failed');
    }
  };

  return (
    <div className="min-h-screen p-5 w-full bg-black text-white">
      {/* Header */}
      <div className="flex items-center justify-center py-8">
        <div className="flex items-center space-x-2">
          <div className="w-8 h-8 bg-gradient-to-r from-pink-500 to-red-500 rounded-full flex items-center justify-center">
            <span className="text-white font-bold text-sm">T</span>
          </div>
          <h1 className="text-2xl font-bold bg-gradient-to-r from-pink-500 to-red-500 bg-clip-text text-transparent">
            TikTok Downloader & Information Extractor
          </h1>
        </div>
      </div>

      {/* Main Content */}
      <div className="w-full  mx-auto px-4">
        {/* Input Form */}
        <form onSubmit={handleSubmit} className="mb-8">
          <div className="flex space-x-2">
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="Paste TikTok URL here..."
              className="flex-1 px-4 py-3 bg-gray-900 border border-gray-700 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:border-pink-500 focus:ring-1 focus:ring-pink-500"
              required
            />
            <button
              type="submit"
              disabled={loading}
              className="px-6 py-3 bg-gradient-to-r from-pink-500 to-red-500 hover:from-pink-600 hover:to-red-600 rounded-lg font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200"
            >
              {loading ? 'Downloading...' : 'Download'}
            </button>
          </div>
        </form>

        {/* Error Message */}
        {error && (
          <div className="mb-6 p-4 bg-red-900/50 border border-red-700 rounded-lg">
            <p className="text-red-400">{error}</p>
          </div>
        )}

        {/* Loading State */}
        {loading && (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-pink-500"></div>
          </div>
        )}

        {/* Results */}
        {result && !loading && (
          <div className="space-y-6">
            <div className='w-full justify-between flex flex-col md:flex-row gap-4'>

              <div className='flex-1 md:sticky md:fixed md:top-8 p-4 space-y-4 bg-gray-900'>
                {/* Info Section */}

                <div className="bg-gray-900 rounded-lg p-6">
                  <div className='mb-4'
                    style={{
                      backgroundImage: `url(${result.origin_cover || 'https://www.transparenttextures.com/patterns/asfalt-light.png'})`,
                      backgroundSize: 'cover',
                      backgroundPosition: 'center',
                      borderRadius: '5px',
                      width: '100%',
                      height: '200px',
                      // padding: '10px',
                    }}>
                    <div className='justify-between p-2 flex'>

                      <div className='border border-gray-700 px-6 h-10 rounded-lg bg-black/50'>
                        <h3 className="text-lg font-semibold text-pink-500">{result.nickname || 'N/A'}</h3>
                      </div>

                    <img
                      src={result.avatar || 'https://abs.twimg.com/sticky/default_profile_images/default_profile_400x400.png'}
                      alt={result.nickname || 'Unknown'}
                        className='w-20 h-20 object-cover rounded-full bg-gray-800 border-4 border-white'
                      onError={e => { e.target.onerror = null; e.target.src = 'https://abs.twimg.com/sticky/default_profile_images/default_profile_400x400.png'; }}
                    />
                  </div>
                  </div>


                  <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mt-5 text-sm">
                    <div>
                      <span className="text-gray-400">ID:</span>
                      <span className="ml-2">{result.id || 'N/A'}</span>
                    </div>
                    <div>
                      <span className="text-gray-400">Username:</span>
                      <span className="ml-2">{result.uniqueId || 'N/A'}</span>
                    </div>
                    <div>
                      <span className="text-gray-400">Country:</span>
                      <span className="ml-2">{result.region || 'N/A'}</span>
                    </div>

                    <div>
                      <span className="text-gray-400">User:</span>
                      <span className="ml-2 capitalize">{result.nickname || 'N/A'}</span>
                    </div>

                    <div>
                      <span className="text-gray-400">Type:</span>
                      <span className="ml-2 capitalize">{result.type || 'N/A'}</span>
                    </div>
                    {/* <div>
                      <span className="text-gray-400">Source:</span>
                      <span className="ml-2">TikTok</span>
                    </div> */}

                    {result.type === 'carousel' && (
                      <div>
                        <span className="text-gray-400">Images:</span>
                        <span className="ml-2">{result.images ? result.images.length : 0}</span>
                      </div>
                    )}

                    {result.type === 'video' && (
                      <>
                        <p className="text-gray-400">Duration:
                          <span className="text-white font-semibold"> {formatDuration(result.duration || 'N/A')}</span>
                        </p>
                      </>
                    )}
                    <div>
                      <span className="text-gray-400">Original Music:</span>
                      <span className="ml-2">{result.original ? "Yes" : "No"}</span>
                    </div>

                    <div>
                      <span className="text-gray-400">Likes:</span>
                      <span className="ml-2">{formatCount(result.likes) || 0}</span>
                    </div>

                    <div>
                      <span className="text-gray-400">Views:</span>
                      <span className="ml-2">{formatCount(result.views) || 0}</span>
                    </div>

                    {/* {result.type === 'video' && (
                      <>
                        <span className="text-gray-400">Views:</span>
                        <span className="ml-2">{result.play_count || 0}</span>
                      </>
                    )} */}

                    <div>
                      <span className="text-gray-400">Comments:</span>
                      <span className="ml-2">{result.comment_count || 0}</span>
                    </div>
                    <div>
                      <span className="text-gray-400">Downloads:</span>
                      <span className="ml-2">{result.download_count || 0}</span>
                    </div>

                    <div>
                      <span className="text-gray-400">Shares:</span>
                      <span className="ml-2">{result.share_count || 0}</span>
                    </div>
                  </div>





                </div>
                {/* Title */}
                <div className="border border-gray-700 rounded-lg p-4 text-center">
                  <h2 className="text-xl text-start font-semibold mb-2">{result.title}</h2>
                  <div className='flex justify-between w-full'>
                    <p className="text-gray-400">By: <span className="font-medium text-pink-500">
                      {result.nickname || 'No description available'}</span></p>
                    <p className="text-gray-400">On: <span className="font-medium text-pink-500">
                      {formatDate(result.postedOn || 'N/A')}</span></p>
                  </div>

                </div>


              </div>


              <div className="flex-1 space-y-6">
                {/* Media Content */}
                {result.type === 'video' && (
                  <div className="bg-gray-900 rounded-lg overflow-hidden">
                    <video
                      controls
                      className="w-full max-h-96 object-contain"
                      src={result.video}
                      poster=""
                    >
                      Your browser does not support the video tag.
                    </video>
                    <div className="p-4">
                      <button
                        onClick={() => downloadFile(result.video, `tiktok-video-${Date.now()}.mp4`)}
                        className="w-full py-3 bg-gradient-to-r from-pink-500 to-red-500 hover:from-pink-600 hover:to-red-600 rounded-lg font-semibold transition-all duration-200"
                      >
                        📥 Download Video
                      </button>
                    </div>
                  </div>
                )}

                {result.type === 'carousel' && (
                  <div className="space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {result.images.map((imageUrl, index) => (
                        <div key={index} className="bg-gray-900 rounded-lg overflow-hidden">
                          <img
                            src={`/api/image?url=${encodeURIComponent(imageUrl)}`}
                            alt={`Slide ${index + 1}`}
                            className="w-full h-64 object-cover"
                            loading="lazy"
                          />
                          <div className="p-3">
                            <button
                              onClick={() => downloadFile(imageUrl, `tiktok-image-${index + 1}-${Date.now()}.jpg`)}
                              className="w-full py-2 bg-gradient-to-r from-pink-500 to-red-500 hover:from-pink-600 hover:to-red-600 rounded-lg font-semibold text-sm transition-all duration-200"
                            >
                              📥 Download Image {index + 1}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="text-center">
                      <button
                        onClick={() => {
                          result.images.forEach((imageUrl, index) => {
                            setTimeout(() => downloadFile(imageUrl, `tiktok-image-${index + 1}-${Date.now()}.jpg`), index * 500);
                          });
                        }}
                        className="px-6 py-3 bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 rounded-lg font-semibold transition-all duration-200"
                      >
                        📥 Download All Images
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>


          </div>
        )}
      </div>

      {/* Footer */}
      <footer className="text-center py-8 text-gray-500 text-sm">
        <p>Built by <span className="font-semibold text-pink-500">Hunter</span>  with ❤️ for downloading TikTok content</p>
      </footer>
    </div>
  );
};

export default App;